// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { getServiceDb } from "@/lib/db";
import { jobs, runners } from "@/lib/db/schema";
import { createHash, randomBytes } from "crypto";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

export type RunnerAuthResult = {
	runnerId: string;
	tokenHash: string;
	/** "managed" | "self" — lets callers require per-job binding for managed runners. */
	operator: string;
	error: NextResponse | null;
};

/** SHA-256 hex digest of a runner token — what we store + compare (never the plaintext). */
export function hashRunnerToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

/** Mints a fresh runner bearer token + its stored hash. */
export function generateRunnerToken(): { token: string; hash: string } {
	const token = randomBytes(32).toString("hex");
	return { token, hash: hashRunnerToken(token) };
}

export async function verifyRunnerToken(
	req: Request,
): Promise<RunnerAuthResult> {
	const runnerId = req.headers.get("X-Runner-ID");
	const runnerToken = req.headers.get("X-Runner-Token");

	if (!runnerId || !runnerToken) {
		return {
			runnerId: "",
			tokenHash: "",
			operator: "",
			error: NextResponse.json(
				{ error: "Missing X-Runner-ID or X-Runner-Token" },
				{ status: 401 },
			),
		};
	}

	const tokenHash = hashRunnerToken(runnerToken);

	const db = getServiceDb();
	const [runner] = await db
		.select({
			id: runners.id,
			token_hash: runners.token_hash,
			operator: runners.operator,
		})
		.from(runners)
		.where(eq(runners.id, runnerId))
		.limit(1);

	if (!runner || runner.token_hash !== tokenHash) {
		return {
			runnerId: "",
			tokenHash: "",
			operator: "",
			error: NextResponse.json(
				{ error: "Invalid runner ID or token" },
				{ status: 401 },
			),
		};
	}

	return { runnerId, tokenHash, operator: runner.operator, error: null };
}

/**
 * Confirms the authenticated runner owns the given job. Runner-facing job routes
 * that read job-scoped data (logs, plan artifacts, the job row) MUST call this after
 * verifyRunnerToken — otherwise any valid runner token can read/write another org's
 * job. Returns a 404/403 NextResponse to return as-is, or null when the runner owns it.
 * (The DB functions update_job_status/insert_job_log already enforce the same scope in
 * SQL; this matches that guard at the HTTP layer for the direct-query routes.)
 */
export async function verifyRunnerOwnsJob(
	runnerId: string,
	jobId: string,
): Promise<NextResponse | null> {
	const db = getServiceDb();
	const [job] = await db
		.select({ runner_id: jobs.runner_id })
		.from(jobs)
		.where(eq(jobs.id, jobId))
		.limit(1);

	if (!job) {
		return NextResponse.json({ error: "Job not found" }, { status: 404 });
	}
	if (job.runner_id !== runnerId) {
		return NextResponse.json(
			{ error: "Runner does not own this job" },
			{ status: 403 },
		);
	}
	return null;
}
