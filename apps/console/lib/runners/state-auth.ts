// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getServiceDb } from "@/lib/db";
import { jobs, runners } from "@/lib/db/schema";
import { jobHoldsStateLock } from "@/lib/runners/state-lock";
import { verifyStateToken } from "@/lib/runners/state-token";
import { runnerStateKey, stateKeyForJob } from "@/lib/storage/tofu-state";

/** The tofu http backend authenticates with HTTP Basic; the state bearer is the password half. */
function basicAuthPassword(req: Request): string | null {
	const header = req.headers.get("authorization") || "";
	const [scheme, encoded] = header.split(" ");
	if (scheme?.toLowerCase() !== "basic" || !encoded) return null;
	let decoded: string;
	try {
		decoded = Buffer.from(encoded, "base64").toString("utf8");
	} catch {
		return null;
	}
	const idx = decoded.indexOf(":");
	return idx === -1 ? decoded : decoded.slice(idx + 1);
}

/**
 * True when the runner whose state object `stateKey` names belongs to the job's tenant (#5481).
 *
 * A runner-lifecycle job keys its state by `config_snapshot.runner_id`, and the key check below
 * proves only that the token and the job agree on that id — not that the runner is the job's. So a
 * job whose snapshot named another org's runner would read and write that runner's state. Admitted:
 *
 * - the runner's `org_id` is the job's `org_id`;
 * - the pre-#3874 shape: the runner sits in its owner's personal org (`org_id = user_id`) and the
 *   job was created by that owner. The jobs route and the console's runner actions file such a
 *   runner's lifecycle jobs in the org the owner is acting in, so its org differs by construction.
 *
 * A key that does not name a runner (a project job's) is not this function's question: it returns
 * true and the project key's own derivation stands.
 */
async function runnerStateInJobTenant(
	db: ReturnType<typeof getServiceDb>,
	job: { config_snapshot: Record<string, unknown>; org_id: string | null; user_id: string },
	stateKey: string,
): Promise<boolean> {
	const rid = job.config_snapshot.runner_id;
	if (typeof rid !== "string" || runnerStateKey(rid) !== stateKey) return true;
	const [runner] = await db
		.select({ org_id: runners.org_id, user_id: runners.user_id })
		.from(runners)
		.where(eq(runners.id, rid))
		.limit(1);
	if (!runner || runner.org_id === null) return false;
	if (job.org_id !== null && runner.org_id === job.org_id) return true;
	return runner.org_id === runner.user_id && runner.user_id === job.user_id;
}

/**
 * Resolved, authorized state request: the server-derived key for the job's state object, and the id
 * of the job the token belongs to — the job actually doing the work, which is the one a lock is filed
 * under (never the URL's job, which for a Plan→Apply is the finished PLAN).
 */
export type StateContext = { stateKey: string; jobId: string };

/** Options for {@link resolveStateRequest}. */
export type StateRequestOptions = {
	/**
	 * Admit a token whose job was CANCELLED while its tofu still holds the state lock — ONLY for the
	 * two calls an interrupted tofu makes on its way out: the final state write and the unlock. Never
	 * set for a read, a lock acquire or a state purge.
	 */
	allowCancelledHolder?: boolean;
};

/**
 * How long after a cancel the cancelled job's own token may still save state and unlock. The runner
 * SIGINTs tofu and waits ALETHIA_CANCEL_GRACE_SECONDS (default 120s) before a hard kill; this is that
 * budget with generous headroom. It is a bound, not the gate: the gate is that the job still HOLDS
 * the lock, which ends the moment the runner reports terminal (releaseStateLocksForJob).
 *
 * Two places read it, and they must agree: this file stops admitting the cancelled job's final write
 * and unlock once it has passed, and the reconcile sweep (lib/reconcile/state-locks.ts) releases a
 * lock the job still holds after it — a runner that died after the cancel never reports terminal, and
 * its lock would otherwise strand until the 3h lock TTL (#7387).
 */
export const CANCELLED_HOLDER_DRAIN_MS = 15 * 60 * 1000;

/** True when a CANCELLED job is still inside the window in which its interrupted tofu may drain. */
function inCancelDrainWindow(completedAt: Date | null, now: number): boolean {
	if (!completedAt) return false;
	const age = now - completedAt.getTime();
	return age >= 0 && age <= CANCELLED_HOLDER_DRAIN_MS;
}

/**
 * Authorizes a tofu-state request. Every method of the state + lock routes calls this. It
 * (1) verifies the state bearer, (2) requires the token's OWN job to be actively provisioning,
 * (3) re-derives that job's state key SERVER-SIDE (project/environment UUIDs, or the target runner id
 * for runner-lifecycle jobs) and cross-checks — never trusts — the token's `key` claim, and (4) requires
 * the job named in the URL to address that SAME state object. Returns the key or a NextResponse.
 *
 * ── Why authorization anchors on the TOKEN's job, not the URL's ─────────────────────────────────
 * OpenTofu EMBEDS the backend config in a saved plan file, and the backend address is per-job
 * (packages/core/cloud/http_backend.go: /api/jobs/<id>/state). So a DEPLOY that reuses a PLAN's saved
 * artifact — the console's Plan→Apply button, and the CLI's `--plan-job-id` — talks to the PLAN job's
 * URL while presenting its OWN (DEPLOY) token. Anchoring on the URL therefore rejected the reuse twice
 * over: `claims.jobId !== pathJobId` (403), and the PLAN job being SUCCESS rather than PROCESSING (409).
 * `Error acquiring the state lock — HTTP remote state endpoint invalid auth` — apply dead on arrival.
 *
 * That check was never the security wall. The state OBJECT is scoped by its KEY, which stateKeyForJob
 * derives from (project_id, environment_id) — so a PLAN and its DEPLOY resolve to the IDENTICAL key by
 * construction. The wall is `claims.key === <server-derived key>` (below), and it is unchanged. The
 * job-id equality only pinned WHICH URL a token could be used at, which is precisely what broke reuse.
 *
 * What is preserved:
 *  - LIVENESS: the token's job must be PROCESSING, so a token from a finished job is dead. It now
 *    tracks the job actually doing the work (the DEPLOY) instead of the finished PLAN.
 *  - SCOPE: a token can only ever touch the one state object it was minted for (the key check).
 *  - NO REPLAY AT AN UNRELATED URL: the path job must resolve to the same key, so a token for project A
 *    cannot be aimed at project B's job URL.
 *
 * Auth is on the signed `sub = jobId`, NOT the job's `runner_id` (which is `onDelete: set null`, so a
 * mid-apply runner detach must not 403 the in-flight state calls).
 *
 * ── The one exception to LIVENESS: a cancelled apply draining (#7290) ───────────────────────────
 * Cancelling flips the job to CANCELLED at once, then signals the runner, which SIGINTs tofu. tofu
 * finishes the resource in flight, then WRITES STATE and UNLOCKS — after the flip. Refusing those two
 * calls threw away the state of everything the apply had created and stranded the lock, so the
 * DESTROY sent to clean up could not run and would have found an empty state if it had. With
 * `allowCancelledHolder`, a CANCELLED token job is admitted iff it is inside the drain window AND
 * still holds the live lock on this exact state object. Every other check (the key wall, the tenant,
 * the URL) applies unchanged, the state write still has to present the held lock id, and the lock is
 * rotated away when the runner reports terminal — so this widens nothing beyond "the writer that
 * already held this state may finish the write it was in the middle of".
 */
export async function resolveStateRequest(
	req: Request,
	pathJobId: string,
	opts: StateRequestOptions = {},
): Promise<StateContext | { error: NextResponse }> {
	const token = basicAuthPassword(req);
	if (!token) {
		return {
			error: NextResponse.json({ error: "Missing state token" }, { status: 401 }),
		};
	}
	const claims = await verifyStateToken(token);
	if (!claims) {
		return {
			error: NextResponse.json({ error: "Invalid state token" }, { status: 403 }),
		};
	}

	const db = getServiceDb();
	const selectJob = {
		job_type: jobs.job_type,
		project_id: jobs.project_id,
		environment_id: jobs.environment_id,
		config_snapshot: jobs.config_snapshot,
		status: jobs.status,
		completed_at: jobs.completed_at,
		org_id: jobs.org_id,
		user_id: jobs.user_id,
	};

	// The AUTHORIZING job is the token's own — the one actually provisioning right now.
	const [tokenJob] = await db
		.select(selectJob)
		.from(jobs)
		.where(eq(jobs.id, claims.jobId))
		.limit(1);

	if (!tokenJob) {
		return {
			error: NextResponse.json({ error: "Job not found" }, { status: 404 }),
		};
	}
	// Liveness: a token is only usable while its job is in flight — or, for the final write and the
	// unlock only, while a cancelled job's interrupted tofu drains (confirmed against the lock below).
	const draining =
		tokenJob.status === "CANCELLED" &&
		opts.allowCancelledHolder === true &&
		inCancelDrainWindow(tokenJob.completed_at, Date.now());
	const notRunning = NextResponse.json(
		{ error: "Job is not currently running" },
		{ status: 409 },
	);
	if (tokenJob.status !== "PROCESSING" && !draining) {
		return { error: notRunning };
	}

	// Shared with the mint route so the token `key` claim can never drift from what we re-derive here.
	const key = stateKeyForJob(tokenJob);
	if ("error" in key) {
		return {
			error: NextResponse.json({ error: key.error }, { status: key.status }),
		};
	}
	const stateKey = key.key;
	// THE WALL: the token was minted for this exact state object. A mismatch means a stale/forged token.
	if (claims.key !== stateKey) {
		return {
			error: NextResponse.json(
				{ error: "State token does not match this job's state" },
				{ status: 403 },
			),
		};
	}

	// THE TENANT: a runner's state object is the job's only when the runner is (#5481).
	if (!(await runnerStateInJobTenant(db, tokenJob, stateKey))) {
		return {
			error: NextResponse.json(
				{ error: "State object is not in this job's tenant" },
				{ status: 403 },
			),
		};
	}

	// The URL must address the SAME state object. This is what stops a token being replayed against an
	// unrelated job's URL (a PLAN→DEPLOY of the same project+env resolves to the same key, so the legit
	// reuse passes). A path job that no longer exists is tolerated: the resource is the state OBJECT,
	// and the token already proved which object it may touch.
	if (pathJobId !== claims.jobId) {
		const [pathJob] = await db
			.select(selectJob)
			.from(jobs)
			.where(eq(jobs.id, pathJobId))
			.limit(1);
		if (pathJob) {
			const pathKey = stateKeyForJob(pathJob);
			if ("error" in pathKey || pathKey.key !== stateKey) {
				return {
					error: NextResponse.json(
						{ error: "State token does not match this job's state" },
						{ status: 403 },
					),
				};
			}
		}
	}

	// A draining cancelled job is admitted only while it still holds THIS state object's live lock.
	// Asked last, once the key, the tenant and the URL have all been proven, so it is a question about
	// the right object.
	if (draining && !(await jobHoldsStateLock(stateKey, claims.jobId))) {
		return { error: notRunning };
	}

	return { stateKey, jobId: claims.jobId };
}
