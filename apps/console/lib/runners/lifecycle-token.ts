// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// How a runner-lifecycle job hands the runner it builds its bearer token.
//
// DEPLOY_RUNNER and UPDATE_RUNNER start a runner container that must authenticate to the console, so
// the runner executing the job needs that container's token to pass as a tofu variable. The token is
// minted HERE, when the job is claimed, and travels only in the claim response to the runner that
// claimed it. Nothing stores the plaintext: not the job's `config_snapshot` (which every job viewer
// reads), not `runners.metadata` (#945). The console keeps only its SHA-256 in `runners.token_hash`.
//
// Until the claim, the target runner's `token_hash` is the hash of a token nobody holds
// ({@link unheldRunnerTokenHash}), so the runner row cannot authenticate between enqueue and claim.
// Re-claiming the same job (a stale-job requeue), re-running it, or a break-glass re-run all mint a
// fresh token at their own claim, which also invalidates whatever an earlier attempt was handed.
//
// The runner binary needs no change: it reads `config_snapshot.runner_token` from the claim
// response exactly as before; the console now puts it there at claim instead of at enqueue.

import { and, eq, or } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/lib/db";
import { runners } from "@/lib/db/schema";
import type { ProvisionJobType } from "@/lib/db/schema/enums";
import { generateRunnerToken } from "@/lib/runners/auth";

/** The snapshot key the runner reads its target's token from (apps/runner deploy_runner.go). */
export const RUNNER_TOKEN_KEY = "runner_token";

/** The job types whose runner needs the target runner's bearer token. DESTROY_RUNNER does not. */
export const RUNNER_TOKEN_JOB_TYPES: readonly ProvisionJobType[] = ["DEPLOY_RUNNER", "UPDATE_RUNNER"];

/** True when a job of this type is handed its target runner's token at claim. */
export function jobNeedsRunnerToken(jobType: ProvisionJobType): boolean {
	return RUNNER_TOKEN_JOB_TYPES.includes(jobType);
}

/**
 * The `token_hash` a runner row carries until its lifecycle job is claimed: the hash of a freshly
 * minted token that is discarded on the spot, so no request can authenticate as that row.
 */
export function unheldRunnerTokenHash(): string {
	return generateRunnerToken().hash;
}

/** The outcome of {@link issueLifecycleRunnerToken}. */
export type LifecycleTokenIssue =
	| { kind: "not-needed" }
	| { kind: "issued"; token: string }
	| { kind: "refused"; reason: string };

/** The fields of a claimed job the issue reads. */
export interface ClaimedLifecycleJob {
	job_type: ProvisionJobType;
	org_id: string | null;
	user_id: string;
	config_snapshot: Record<string, unknown>;
}

const targetRunnerId = z.uuid();

/**
 * Mints the target runner's bearer token for a claimed DEPLOY_RUNNER / UPDATE_RUNNER job and stores
 * only its hash on the target's row. Returns the plaintext for the claim response alone.
 *
 * Refused — the caller fails the job — when the snapshot names no target, when the claiming runner
 * IS the target (rotating its own token would cut it off mid-job), or when the target is not a
 * self-operated runner of the job's own organization. The last check is one guarded UPDATE, so the
 * row that receives the new hash is exactly the row that passed it.
 *
 * "The job's own organization" admits one legacy shape, the one `claim_next_job` admits for the
 * executing runner too: a runner registered before #3874 was stamped into its owner's personal org
 * (`org_id = user_id`), and its owner's lifecycle jobs are stamped with the org they were working in.
 */
export async function issueLifecycleRunnerToken(
	db: Db,
	job: ClaimedLifecycleJob,
	claimingRunnerId: string,
): Promise<LifecycleTokenIssue> {
	if (!jobNeedsRunnerToken(job.job_type)) return { kind: "not-needed" };

	const target = targetRunnerId.safeParse(job.config_snapshot.runner_id);
	if (!target.success) {
		return { kind: "refused", reason: "the job does not name the runner it builds" };
	}
	if (target.data === claimingRunnerId) {
		return { kind: "refused", reason: "a runner cannot run its own lifecycle job" };
	}
	if (!job.org_id) {
		return { kind: "refused", reason: "the job has no organization" };
	}

	const { token, hash } = generateRunnerToken();
	const updated = await db
		.update(runners)
		.set({ token_hash: hash })
		.where(
			and(
				eq(runners.id, target.data),
				eq(runners.operator, "self"),
				or(
					eq(runners.org_id, job.org_id),
					and(eq(runners.org_id, runners.user_id), eq(runners.user_id, job.user_id)),
				),
			),
		)
		.returning({ id: runners.id });

	if (updated.length === 0) {
		return {
			kind: "refused",
			reason: "the runner this job builds no longer exists in the job's organization",
		};
	}
	return { kind: "issued", token };
}

/** The claim response's copy of a job snapshot, carrying the token issued for this claim. */
export function snapshotWithRunnerToken(
	snapshot: Record<string, unknown>,
	token: string,
): Record<string, unknown> {
	return { ...snapshot, [RUNNER_TOKEN_KEY]: token };
}

/**
 * A snapshot copied into a new job (a re-run) without any runner token it carries: the new job is
 * issued its own at claim.
 */
export function snapshotWithoutRunnerToken(
	snapshot: Record<string, unknown>,
): Record<string, unknown> {
	const copy = { ...snapshot };
	delete copy[RUNNER_TOKEN_KEY];
	return copy;
}
