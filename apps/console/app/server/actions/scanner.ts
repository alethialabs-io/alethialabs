"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { eq } from "drizzle-orm";
import { signedJob } from "@/lib/db/signed-job";
import { getVerifiedCloudIdentities } from "@/app/server/actions/aws/identities";
import { requireOwner } from "@/lib/auth/owner";
import { currentActor } from "@/lib/authz/guard";
import { AiBudgetError, assertAiAllowed } from "@/lib/billing/ai-guard";
import { recordAiUsage } from "@/lib/billing/ai-quota";
import type { CloudProviderSlug } from "@/lib/cloud-providers";
import { withOwnerScope } from "@/lib/db";
import { jobs } from "@/lib/db/schema";
import { notifyScaler } from "@/lib/scaler";
import { inferStack } from "@/lib/scanner/infer";
import type { ScanProposal } from "@/lib/scanner/schema";
import {
	inferredStackToFormData,
	mergeScansToFormData,
	type ScanInput,
} from "@/lib/scanner/to-project";
import type { RepoDigest } from "@/types/jsonb.types";

/** Narrow a free-form provider string to a known slug (no casts). */
function toSlug(p: string): CloudProviderSlug {
	return p === "gcp" || p === "azure" ? p : "aws";
}

/**
 * Queue an ANALYZE_REPO job: a runner clones the repo and statically parses it into
 * a RepoDigest (no repo code executed). Returns the job id to poll/stream. The repo
 * URL lives in config_snapshot; the runner resolves a git token via /git-token (which
 * falls back to config_snapshot.repo_url for project-less scan jobs).
 *
 * B6 will front this with `assertScanAllowed` (entitlement + per-scan meter).
 */
export async function scanRepo(repoUrl: string, opts?: { ref?: string }) {
	const actor = await currentActor();
	const url = repoUrl.trim();
	if (!url) throw new Error("A repository URL is required.");
	// Surface a clean budget message (never a raw AiBudgetError) so the scan UI can toast
	// "You're out of AI usage…" with the reset time instead of a stack trace.
	const charge = await assertAiAllowed(actor.orgId, "scan", actor.userId).catch((e: unknown) => {
		if (e instanceof AiBudgetError) throw new Error(e.message);
		throw e;
	});

	const jobId = await withOwnerScope(actor.userId, async (tx) => {
		const [job] = await tx
			.insert(jobs)
			.values(signedJob({
				user_id: actor.userId,
				job_type: "ANALYZE_REPO",
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

/** Read a scan job's status + the digest the runner produced (null until done). */
export async function getScanDigest(jobId: string): Promise<{
	status: string;
	digest: RepoDigest | null;
	error: string | null;
}> {
	const owner = await requireOwner();
	return withOwnerScope(owner, async (tx) => {
		const [job] = await tx
			.select({
				status: jobs.status,
				execution_metadata: jobs.execution_metadata,
				error_message: jobs.error_message,
			})
			.from(jobs)
			.where(eq(jobs.id, jobId))
			.limit(1);
		if (!job) return { status: "NOT_FOUND", digest: null, error: "Job not found" };
		return {
			status: job.status,
			digest: job.execution_metadata?.repo_digest ?? null,
			error: job.error_message,
		};
	});
}

/**
 * Build a review-ready proposal from a completed scan: model infers an InferredStack
 * from the digest, then a deterministic mapper turns it into a guaranteed-valid Project
 * (placed on the user's default cloud account). Recomputes on demand (caching is a later
 * optimization). The result opens in the canvas via `?scan=<jobId>`. A project is a
 * top-level project now, so no grouping layer is required.
 */
export async function getScanProposal(jobId: string): Promise<
	| { status: "NOT_FOUND" }
	| { status: "PENDING"; jobStatus: string }
	| { status: "NEEDS_SETUP"; needsIdentity: boolean }
	| { status: "READY"; proposal: ScanProposal }
> {
	const owner = await requireOwner();
	const job = await withOwnerScope(owner, async (tx) => {
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
		typeof job.config_snapshot?.repo_url === "string"
			? job.config_snapshot.repo_url
			: "";
	const ref =
		typeof job.config_snapshot?.ref === "string" ? job.config_snapshot.ref : undefined;

	const inferred = await inferStack(digest);
	const stack = inferred.stack;
	// Record the inference's real token cost (credits were already charged at queue
	// time in scanRepo; this 0-credit row carries cost-of-serve only).
	const scanActor = await currentActor();
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
	});

	const identities = await getVerifiedCloudIdentities();
	if (identities.length === 0) {
		return { status: "NEEDS_SETUP", needsIdentity: true };
	}

	const identity = identities[0];
	const provider = toSlug(identity.provider);
	const proposedProject = inferredStackToFormData(stack, {
		identityId: identity.id,
		provider,
		repoUrl,
		ref,
		services: digest.services,
	});

	return {
		status: "READY",
		proposal: { stack, proposedProject, provider, identityId: identity.id },
	};
}

/**
 * Multi-repo proposal: infer each finished scan job and MERGE them into one project
 * (union backing needs, one source_repos row per repo — see mergeScansToFormData). Any
 * job still without a digest short-circuits to PENDING; the caller polls until all are
 * ready. Mirrors getScanProposal's states + per-job cost-of-serve metering.
 */
export async function getMergedScanProposal(jobIds: string[]): Promise<
	| { status: "NOT_FOUND" }
	| { status: "PENDING"; jobStatus: string }
	| { status: "NEEDS_SETUP"; needsIdentity: boolean }
	| { status: "READY"; proposal: ScanProposal }
> {
	const owner = await requireOwner();
	if (jobIds.length === 0) return { status: "NOT_FOUND" };
	const scanActor = await currentActor();

	const inputs: ScanInput[] = [];
	for (const jobId of jobIds) {
		const job = await withOwnerScope(owner, async (tx) => {
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
		});
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
