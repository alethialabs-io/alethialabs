// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getServiceDb } from "@/lib/db";
import { jobs } from "@/lib/db/schema";
import { verifyStateToken } from "@/lib/runners/state-token";
import { stateKeyForJob } from "@/lib/storage/tofu-state";

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

/** Resolved, authorized state request: the server-derived key for the job's state object. */
export type StateContext = { stateKey: string };

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
 */
export async function resolveStateRequest(
	req: Request,
	pathJobId: string,
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
	// Liveness: a token is only usable while its job is in flight.
	if (tokenJob.status !== "PROCESSING") {
		return {
			error: NextResponse.json(
				{ error: "Job is not currently running" },
				{ status: 409 },
			),
		};
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

	return { stateKey };
}
