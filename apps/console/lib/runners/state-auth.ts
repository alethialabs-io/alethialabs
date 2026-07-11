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
 * Authorizes a tofu-state request for `pathJobId`. Every method of the state + lock routes calls
 * this. It (1) verifies the per-job state bearer, (2) binds it to the path job id, (3) requires the
 * job to be actively provisioning, and (4) re-derives the state key SERVER-SIDE from the job (project/
 * environment UUIDs, or the target runner id for runner-lifecycle jobs) — cross-checking (not trusting)
 * the token's `key` claim. Returns the key or a NextResponse to return as-is.
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
	if (!claims || claims.jobId !== pathJobId) {
		return {
			error: NextResponse.json({ error: "Invalid state token" }, { status: 403 }),
		};
	}

	const db = getServiceDb();
	const [job] = await db
		.select({
			job_type: jobs.job_type,
			project_id: jobs.project_id,
			environment_id: jobs.environment_id,
			config_snapshot: jobs.config_snapshot,
			status: jobs.status,
		})
		.from(jobs)
		.where(eq(jobs.id, pathJobId))
		.limit(1);

	if (!job) {
		return {
			error: NextResponse.json({ error: "Job not found" }, { status: 404 }),
		};
	}
	if (job.status !== "PROCESSING") {
		return {
			error: NextResponse.json(
				{ error: "Job is not currently running" },
				{ status: 409 },
			),
		};
	}

	// Shared with the mint route so the token `key` claim can never drift from what we re-derive here.
	const key = stateKeyForJob(job);
	if ("error" in key) {
		return {
			error: NextResponse.json({ error: key.error }, { status: key.status }),
		};
	}
	const stateKey = key.key;
	// Defense in depth: the token was minted for this exact key. A mismatch means a stale/forged token.
	if (claims.key !== stateKey) {
		return {
			error: NextResponse.json(
				{ error: "State token does not match this job's state" },
				{ status: 403 },
			),
		};
	}

	return { stateKey };
}
