"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { eq } from "drizzle-orm";
import { getVerifiedCloudIdentities } from "@/app/server/actions/aws/identities";
import { getZones } from "@/app/server/actions/zones";
import { requireOwner } from "@/lib/auth/owner";
import { currentActor } from "@/lib/authz/guard";
import { assertAiAllowed } from "@/lib/billing/ai-guard";
import { recordAiUsage } from "@/lib/billing/ai-quota";
import type { CloudProviderSlug } from "@/lib/cloud-providers";
import { withOwnerScope } from "@/lib/db";
import { jobs } from "@/lib/db/schema";
import { notifyScaler } from "@/lib/scaler";
import { inferStack } from "@/lib/scanner/infer";
import type { ScanProposal } from "@/lib/scanner/schema";
import { inferredStackToFormData } from "@/lib/scanner/to-spec";
import type { RepoDigest } from "@/types/database-custom.types";

/** Narrow a free-form provider string to a known slug (no casts). */
function toSlug(p: string): CloudProviderSlug {
	return p === "gcp" || p === "azure" ? p : "aws";
}

/**
 * Queue an ANALYZE_REPO job: a runner clones the repo and statically parses it into
 * a RepoDigest (no repo code executed). Returns the job id to poll/stream. The repo
 * URL lives in config_snapshot; the runner resolves a git token via /git-token (which
 * falls back to config_snapshot.repo_url for spec-less scan jobs).
 *
 * B6 will front this with `assertScanAllowed` (entitlement + per-scan meter).
 */
export async function scanRepo(repoUrl: string, opts?: { ref?: string }) {
	const actor = await currentActor();
	const url = repoUrl.trim();
	if (!url) throw new Error("A repository URL is required.");
	const charge = await assertAiAllowed(actor.orgId, "scan");

	const jobId = await withOwnerScope(actor.userId, async (tx) => {
		const [job] = await tx
			.insert(jobs)
			.values({
				user_id: actor.userId,
				job_type: "ANALYZE_REPO",
				status: "QUEUED",
				config_snapshot: { repo_url: url, ...(opts?.ref ? { ref: opts.ref } : {}) },
			})
			.returning({ id: jobs.id });
		return job.id;
	});

	await recordAiUsage({
		orgId: actor.orgId,
		userId: actor.userId,
		kind: "scan",
		credits: charge.credits,
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
 * from the digest, then a deterministic mapper turns it into a guaranteed-valid Spec
 * (placed on the user's default cloud account + zone). Recomputes on demand (caching
 * is a later optimization). The result opens in the canvas via `?scan=<jobId>`.
 */
export async function getScanProposal(jobId: string): Promise<
	| { status: "NOT_FOUND" }
	| { status: "PENDING"; jobStatus: string }
	| { status: "NEEDS_SETUP"; needsIdentity: boolean; needsZone: boolean }
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
	const { zones } = await getZones();
	if (identities.length === 0 || zones.length === 0) {
		return {
			status: "NEEDS_SETUP",
			needsIdentity: identities.length === 0,
			needsZone: zones.length === 0,
		};
	}

	const identity = identities[0];
	const provider = toSlug(identity.provider);
	const proposedSpec = inferredStackToFormData(stack, {
		identityId: identity.id,
		provider,
		zoneId: zones[0].id,
		repoUrl,
	});

	return {
		status: "READY",
		proposal: { stack, proposedSpec, provider, identityId: identity.id },
	};
}
