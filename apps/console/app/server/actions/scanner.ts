"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { eq } from "drizzle-orm";
import { z } from "zod";
import { signedJob } from "@/lib/db/signed-job";
import { getVerifiedCloudIdentities } from "@/app/server/actions/aws/identities";
import { defineAction } from "@/lib/actions/define-action";
import { ActionRefusal, type ActionResult } from "@/lib/actions/result";
import { currentActor } from "@/lib/authz/guard";
import { AiBudgetError, assertAiAllowed } from "@/lib/billing/ai-guard";
import { meteringFailed, recordAiUsage } from "@/lib/billing/ai-quota";
import { assertJobQuotaAllowed } from "@/lib/billing/job-quota";
import { UsageLimitError } from "@/lib/billing/usage-guard";
import type { CloudProviderSlug } from "@/lib/cloud-providers";
import { withActorScope } from "@/lib/db";
import { jobs } from "@/lib/db/schema";
import { notifyScaler } from "@/lib/scaler";
import { inferStack } from "@/lib/scanner/infer";
import type { ScanProposal } from "@/lib/scanner/schema";
import { mergeScansToFormData, type ScanInput } from "@/lib/scanner/to-project";

/** Narrow a free-form provider string to a known slug (no casts). */
function toSlug(p: string): CloudProviderSlug {
	return p === "gcp" || p === "azure" ? p : "aws";
}

/**
 * Queues an ANALYZE_REPO job and returns its id, THROWING the budget refusals as their own classes
 * ({@link AiBudgetError}, {@link UsageLimitError}) so each caller maps them in its own words. Not
 * exported: the two exports below are the callers, and each establishes the actor first.
 */
async function queueRepoScan(repoUrl: string, opts?: { ref?: string }): Promise<{ jobId: string }> {
	const actor = await currentActor();
	const url = repoUrl.trim();
	if (!url) throw new Error("A repository URL is required.");
	const charge = await assertAiAllowed(actor.orgId, "scan", actor.userId);
	await assertJobQuotaAllowed(actor.orgId);

	const jobId = await withActorScope(actor, async (tx) => {
		const [job] = await tx
			.insert(jobs)
			.values(signedJob({
				user_id: actor.userId,
				job_type: "ANALYZE_REPO",
				initiated_by: "user",
				status: "QUEUED",
				config_snapshot: { repo_url: url, ...(opts?.ref ? { ref: opts.ref } : {}) },
			}))
			.returning({ id: jobs.id });
		return job.id;
	});

	await recordAiUsage({
		orgId: actor.orgId,
		userId: actor.userId,
		kind: "scan",
		// Scan is the FIXED path — book the reserved nominal charge (SCAN_CREDITS).
		credits: charge.settle ? undefined : charge.credits,
		source: charge.source,
		refId: jobId,
	});
	notifyScaler();
	return { jobId };
}

/**
 * Queue an ANALYZE_REPO job: a runner clones the repo and statically parses it into
 * a RepoDigest (no repo code executed). Returns the job id to poll/stream. The repo
 * URL lives in config_snapshot; the runner resolves a git token via /git-token (which
 * falls back to config_snapshot.repo_url for project-less scan jobs).
 *
 * The assistant's `scan_repo` tool calls this in-process, so a refusal is a thrown message it can
 * relay. The console's import panel calls {@link startRepoScan} instead.
 *
 * B6 will front this with `assertScanAllowed` (entitlement + per-scan meter).
 */
export async function scanRepo(repoUrl: string, opts?: { ref?: string }) {
	try {
		return await queueRepoScan(repoUrl, opts);
	} catch (e) {
		// Surface a clean budget message (never a raw AiBudgetError) so the caller can say
		// "You're out of AI usage…" with the reset time instead of a stack trace.
		if (e instanceof AiBudgetError) throw new Error(e.message);
		throw e;
	}
}

const startRepoScanInput = z.object({
	repoUrl: z.string().trim().min(1, "Pick a repository to import."),
	ref: z.string().trim().min(1).optional(),
});

/**
 * The import panel's "Scan repository" (#6131), through the mutation contract (ADR 0005 D4): the
 * same queue as {@link scanRepo}, answering `ActionResult` so the panel gets a pending state, a
 * double-submit guard and a readable refusal. A thrown message out of a `"use server"` export is a
 * digest in a production build, so the two budget refusals — the ones a user can act on — come back
 * as entitlement refusals in their own words; anything else is an unexpected error with a reference.
 */
export async function startRepoScan(
	raw: z.input<typeof startRepoScanInput>,
): Promise<ActionResult<{ jobId: string }>> {
	return defineAction({
		input: startRepoScanInput,
		run: async ({ input }) => {
			try {
				return await queueRepoScan(input.repoUrl, input.ref ? { ref: input.ref } : undefined);
			} catch (e) {
				if (e instanceof AiBudgetError) throw new ActionRefusal("entitlement", e.message, "ai");
				if (e instanceof UsageLimitError) throw new ActionRefusal("entitlement", e.message, "jobs");
				throw e;
			}
		},
	})(raw);
}

/**
 * Multi-repo proposal: infer each finished scan job and MERGE them into one project
 * (union backing needs, one source_repos row per repo — see mergeScansToFormData). Any
 * job still without a digest short-circuits to PENDING; the caller polls until all are
 * ready. Mirrors `readScanProposal`'s states (lib/rpc/procedures/projects.ts) + per-job cost-of-serve metering.
 */
export async function getMergedScanProposal(jobIds: string[]): Promise<
	| { status: "NOT_FOUND" }
	| { status: "PENDING"; jobStatus: string }
	| { status: "NEEDS_SETUP"; needsIdentity: boolean }
	| { status: "READY"; proposal: ScanProposal }
> {
	if (jobIds.length === 0) return { status: "NOT_FOUND" };
	const scanActor = await currentActor();

	const inputs: ScanInput[] = [];
	for (const jobId of jobIds) {
		const job = await withActorScope(scanActor, async (tx) => {
			const [j] = await tx
				.select({
					status: jobs.status,
					execution_metadata: jobs.execution_metadata,
					config_snapshot: jobs.config_snapshot,
				})
				.from(jobs)
				.where(eq(jobs.id, jobId))
				.limit(1);
			return j ?? null;
		});
		if (!job) return { status: "NOT_FOUND" };
		const digest = job.execution_metadata?.repo_digest ?? null;
		if (!digest) return { status: "PENDING", jobStatus: job.status };

		const repoUrl =
			typeof job.config_snapshot?.repo_url === "string" ? job.config_snapshot.repo_url : "";
		const ref =
			typeof job.config_snapshot?.ref === "string" ? job.config_snapshot.ref : undefined;
		const inferred = await inferStack(digest);
		void recordAiUsage({
			orgId: scanActor.orgId,
			userId: scanActor.userId,
			kind: "scan",
			credits: 0,
			source: "included",
			refId: jobId,
			model: inferred.model,
			inputTokens: inferred.inputTokens,
			outputTokens: inferred.outputTokens,
			cachedInputTokens: inferred.cachedInputTokens,
		}).catch(meteringFailed(scanActor.orgId));
		inputs.push({ stack: inferred.stack, repoUrl, ref, services: digest.services });
	}

	const identities = await getVerifiedCloudIdentities();
	if (identities.length === 0) return { status: "NEEDS_SETUP", needsIdentity: true };
	const identity = identities[0];
	const provider = toSlug(identity.provider);
	const proposedProject = mergeScansToFormData(inputs, {
		identityId: identity.id,
		provider,
	});

	return {
		status: "READY",
		// The first repo's stack heads the display; the merged project carries them all.
		proposal: { stack: inputs[0].stack, proposedProject, provider, identityId: identity.id },
	};
}
