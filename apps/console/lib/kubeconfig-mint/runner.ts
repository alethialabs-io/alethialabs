// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Steps 2 and 4 of the kubeconfig mint channel (#5281): the runner reads what to mint, and posts the
// sealed result back. Both run on the service role — a runner has no actor — so every query here
// names the job, and the job names the runner that holds it.
//
// OWNERSHIP. A runner reaches a mint ONLY through a MINT_KUBECONFIG job it has CLAIMED and is
// executing (`jobs.runner_id` = the authenticated runner, status CLAIMED/PROCESSING). Another runner's
// token reads nothing and writes nothing, and the result post's `mint_id` must be the mint THAT job
// serves — a runner cannot land a ciphertext on someone else's request by naming its id. The job's
// completion goes through `update_job_status`, which re-checks the ownership in SQL inside the same
// transaction.
//
// WHAT IS STORED. Ciphertext only (the console cannot open it), and for a failure one sentence from
// the fixed set in ./reasons — never the text the runner posted.

import { and, eq, gt, sql } from "drizzle-orm";
import { getServiceDb } from "@/lib/db";
import { jobs, kubeconfigMintRequests } from "@/lib/db/schema";
import type {
	RunnerKubeconfigMintResult,
	RunnerKubeconfigMintSpec,
} from "@/lib/validations/cli-contract";
import { fixedFailureReason } from "./reasons";

/** Why a runner was refused. Each maps to one HTTP status in the route. */
export type RunnerMintRefusal =
	| "job-not-found"
	| "not-owner"
	| "not-a-mint"
	| "not-executing"
	| "mint-not-found"
	| "mint-mismatch"
	| "mint-expired"
	| "mint-settled";

/** The executing MINT_KUBECONFIG job a runner may act on. */
interface GatedJob {
	id: string;
}

/**
 * The job gate shared by the spec read and the result post: the job exists, `runnerId` holds it,
 * it is a MINT_KUBECONFIG job, and it is executing (CLAIMED/PROCESSING — the same narrowing the
 * addon-secrets and talosconfig channels use, so a leaked runner token cannot replay against a
 * finished job).
 */
async function gateMintJob(
	runnerId: string,
	jobId: string,
): Promise<{ ok: true; job: GatedJob } | { ok: false; refusal: RunnerMintRefusal }> {
	const [job] = await getServiceDb()
		.select({
			id: jobs.id,
			runner_id: jobs.runner_id,
			job_type: jobs.job_type,
			status: jobs.status,
		})
		.from(jobs)
		.where(eq(jobs.id, jobId))
		.limit(1);
	if (!job) return { ok: false, refusal: "job-not-found" };
	if (job.runner_id !== runnerId) return { ok: false, refusal: "not-owner" };
	if (job.job_type !== "MINT_KUBECONFIG") return { ok: false, refusal: "not-a-mint" };
	if (job.status !== "CLAIMED" && job.status !== "PROCESSING") {
		return { ok: false, refusal: "not-executing" };
	}
	return { ok: true, job: { id: job.id } };
}

/**
 * What the runner must mint for `jobId`, and whom to seal it to. Refused unless `runnerId` owns the
 * executing MINT_KUBECONFIG job, and unless that job's mint is still pending inside its window.
 */
export async function readMintSpec(
	runnerId: string,
	jobId: string,
): Promise<
	{ ok: true; spec: RunnerKubeconfigMintSpec } | { ok: false; refusal: RunnerMintRefusal }
> {
	const gate = await gateMintJob(runnerId, jobId);
	if (!gate.ok) return gate;

	const [row] = await getServiceDb()
		.select({
			mint_id: kubeconfigMintRequests.id,
			cluster_id: kubeconfigMintRequests.cluster_id,
			tier: kubeconfigMintRequests.tier,
			shape: kubeconfigMintRequests.shape,
			ttl_seconds: kubeconfigMintRequests.ttl_seconds,
			client_public_key: kubeconfigMintRequests.client_public_key,
			status: kubeconfigMintRequests.status,
			expired_now: sql<boolean>`${kubeconfigMintRequests.expires_at} <= now()`,
		})
		.from(kubeconfigMintRequests)
		.where(eq(kubeconfigMintRequests.job_id, gate.job.id))
		.limit(1);
	if (!row) return { ok: false, refusal: "mint-not-found" };
	if (row.expired_now || row.status === "expired") {
		return { ok: false, refusal: "mint-expired" };
	}
	if (row.status !== "pending") return { ok: false, refusal: "mint-settled" };

	return {
		ok: true,
		spec: {
			mint_id: row.mint_id,
			cluster_id: row.cluster_id,
			tier: row.tier,
			shape: row.shape,
			ttl_seconds: row.ttl_seconds,
			client_public_key: row.client_public_key,
		},
	};
}

/**
 * Lands the runner's result on the mint its job serves, and completes the job, in ONE transaction:
 * the row moves pending → ready (ciphertext) or pending → failed (a fixed reason), and the job moves
 * to SUCCESS or FAILED through `update_job_status` with the runner's own credentials. Nothing is
 * written unless the row was still pending and inside its window.
 *
 * Returns the reason that was stored on a failure, so the route can say which sentence the client
 * will see. Throws a Postgres error carrying JOB_NOT_OWNED_SQLSTATE if the job left this runner
 * between the gate and the write.
 */
export async function recordMintResult(
	runner: { runnerId: string; tokenHash: string },
	jobId: string,
	result: RunnerKubeconfigMintResult,
): Promise<
	| { ok: true; storedReason: string | null }
	| { ok: false; refusal: RunnerMintRefusal }
> {
	const gate = await gateMintJob(runner.runnerId, jobId);
	if (!gate.ok) return gate;

	const db = getServiceDb();
	const [owned] = await db
		.select({
			id: kubeconfigMintRequests.id,
			status: kubeconfigMintRequests.status,
			expired_now: sql<boolean>`${kubeconfigMintRequests.expires_at} <= now()`,
		})
		.from(kubeconfigMintRequests)
		.where(eq(kubeconfigMintRequests.job_id, gate.job.id))
		.limit(1);
	if (!owned) return { ok: false, refusal: "mint-not-found" };
	// The mint this job serves, by the job — never the id the runner named on its own say-so.
	if (owned.id !== result.mint_id) return { ok: false, refusal: "mint-mismatch" };
	if (owned.expired_now || owned.status === "expired") {
		return { ok: false, refusal: "mint-expired" };
	}
	if (owned.status !== "pending") return { ok: false, refusal: "mint-settled" };

	const storedReason =
		result.status === "failed" ? fixedFailureReason(result.reason) : null;

	const landed = await db.transaction(async (tx) => {
		const [moved] = await tx
			.update(kubeconfigMintRequests)
			.set(
				result.status === "ready"
					? {
							status: "ready",
							sealed_result: result.sealed,
							failure_reason: null,
							private_endpoint: result.private_endpoint,
						}
					: {
							status: "failed",
							sealed_result: null,
							failure_reason: storedReason,
							private_endpoint: result.private_endpoint,
						},
			)
			.where(
				and(
					eq(kubeconfigMintRequests.id, owned.id),
					eq(kubeconfigMintRequests.job_id, gate.job.id),
					eq(kubeconfigMintRequests.status, "pending"),
					gt(kubeconfigMintRequests.expires_at, sql`now()`),
				),
			)
			.returning({ id: kubeconfigMintRequests.id });
		// Lost a race with the sweep or a second post: write nothing, complete nothing.
		if (!moved) return false;

		await tx.execute(
			sql`select update_job_status(${runner.runnerId}::uuid, ${runner.tokenHash}, ${gate.job.id}::uuid, ${result.status === "ready" ? "SUCCESS" : "FAILED"}, ${storedReason}, null::jsonb)`,
		);
		return true;
	});
	if (!landed) return { ok: false, refusal: "mint-settled" };
	return { ok: true, storedReason };
}
