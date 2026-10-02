// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The runner's half of the kubeconfig mint channel (#5281; drawn in lib/validations/cli-contract.ts).
//
//   GET  — step 2: the runner that holds an executing MINT_KUBECONFIG job reads what to mint and the
//          client's PUBLIC key to seal it to (`runnerKubeconfigMintSpec`). Nothing secret is served.
//   POST — step 4: the ONE-SHOT result channel. The runner posts the HPKE-sealed credential, or a
//          failure (`runnerKubeconfigMintResult`). Never execution_metadata, job_logs or the status
//          post (#5250 decision 3). The console stores the ciphertext — which it cannot open — and
//          for a failure only a sentence from the fixed set in lib/kubeconfig-mint/reasons.ts. The
//          same transaction completes the job through `update_job_status`, so the runner does not
//          need to post a terminal status afterwards (a same-status post is harmless).
//
// Runner-authenticated exactly like the sibling `/api/jobs/[id]/*` channels (talosconfig,
// addon-secrets): the X-Runner-ID/X-Runner-Token pair, then the job must be THIS runner's, a
// MINT_KUBECONFIG job, and executing. The POST's `mint_id` must be the mint that job serves.

import { errorName } from "@/lib/errors";
import { reportJobUsageOnce } from "@/lib/billing/meter";
import { cliJson } from "@/lib/cli/respond";
import { JOB_NOT_OWNED_SQLSTATE, pgErrorCode } from "@/lib/db/pg-error";
import { mintError, noStore } from "@/lib/kubeconfig-mint/http";
import {
	type RunnerMintRefusal,
	readMintSpec,
	recordMintResult,
} from "@/lib/kubeconfig-mint/runner";
import { log } from "@/lib/observability/log";
import { verifyRunnerToken } from "@/lib/runners/auth";
import {
	cliOkResponse,
	runnerKubeconfigMintResult,
	runnerKubeconfigMintSpec,
} from "@/lib/validations/cli-contract";

const mlog = log.child({ component: "kubeconfig-mint" });

/** The HTTP status and message for each reason a runner was refused. */
function refusalResponse(refusal: RunnerMintRefusal): Response {
	switch (refusal) {
		case "job-not-found":
			return mintError(404, "Job not found");
		case "not-owner":
			return mintError(403, "Runner does not own this job");
		case "not-a-mint":
			return mintError(403, "Job is not a kubeconfig mint");
		case "not-executing":
			return mintError(403, "Job is not executing");
		case "mint-not-found":
			return mintError(404, "Kubeconfig mint not found for this job");
		case "mint-mismatch":
			return mintError(403, "mint_id is not the mint this job serves");
		case "mint-expired":
			return mintError(410, "The kubeconfig mint's window has closed");
		case "mint-settled":
			return mintError(409, "The kubeconfig mint already has a result");
	}
}

/** Serves the owning runner the spec of the mint its executing MINT_KUBECONFIG job serves. */
export async function GET(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
): Promise<Response> {
	const { id: jobId } = await params;
	const { runnerId, error: authError } = await verifyRunnerToken(req);
	if (authError) return noStore(authError);

	try {
		const outcome = await readMintSpec(runnerId, jobId);
		if (!outcome.ok) return refusalResponse(outcome.refusal);
		return noStore(cliJson(runnerKubeconfigMintSpec, outcome.spec));
	} catch (err: unknown) {
		mlog.error("kubeconfig mint spec read failed", {
			job_id: jobId,
			runner_id: runnerId,
			err_name: errorName(err),
		});
		return mintError(500, "Internal Server Error");
	}
}

/**
 * Takes the owning runner's sealed result (or fixed-vocabulary failure) for its mint and completes
 * the job. The body is never echoed or logged: a `ready` body is ciphertext, and a `failed` body's
 * reason is runner-written text that this route exists to keep out of storage and out of logs.
 */
export async function POST(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
): Promise<Response> {
	const { id: jobId } = await params;
	const { runnerId, tokenHash, error: authError } = await verifyRunnerToken(req);
	if (authError) return noStore(authError);

	const raw: unknown = await req.json().catch(() => undefined);
	const parsed = runnerKubeconfigMintResult.safeParse(raw);
	if (!parsed.success) {
		return mintError(400, "Invalid kubeconfig mint result");
	}

	try {
		const outcome = await recordMintResult({ runnerId, tokenHash }, jobId, parsed.data);
		if (!outcome.ok) return refusalResponse(outcome.refusal);

		if (
			parsed.data.status === "failed" &&
			outcome.storedReason !== parsed.data.reason
		) {
			// Says THAT the runner sent text outside the fixed set, never what it was.
			mlog.warn("runner posted a mint failure reason outside the fixed set; stored the generic one", {
				job_id: jobId,
				runner_id: runnerId,
				reason_length: parsed.data.reason.length,
			});
		}

		// Bill the job's runner-minutes once it is terminal, like every other job (best-effort).
		try {
			await reportJobUsageOnce(jobId);
		} catch (err: unknown) {
			mlog.error("usage metering failed", { job_id: jobId, err_name: errorName(err) });
		}
		return noStore(cliJson(cliOkResponse, { ok: true }));
	} catch (err: unknown) {
		// The job left this runner between the gate and the write (stale-job recovery requeued it).
		if (pgErrorCode(err) === JOB_NOT_OWNED_SQLSTATE) {
			return mintError(409, "Job not found or not owned by this runner");
		}
		mlog.error("kubeconfig mint result failed", {
			job_id: jobId,
			runner_id: runnerId,
			err_name: errorName(err),
		});
		return mintError(500, "Internal Server Error");
	}
}
