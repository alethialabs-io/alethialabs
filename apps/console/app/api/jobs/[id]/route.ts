// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { getServiceDb } from "@/lib/db";
import { jobs } from "@/lib/db/schema";
import { verifyRunnerMayReadJob, verifyRunnerToken } from "@/lib/runners/auth";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

/** Returns a job row to the runner that may read it (see {@link verifyRunnerMayReadJob}). */
export async function GET(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { runnerId, error: authError } = await verifyRunnerToken(req);
	if (authError) return authError;

	const { id: jobId } = await params;

	try {
		// A runner reads a job it owns, or the PLAN its in-flight DEPLOY or DESTROY applies — otherwise any valid
		// runner token could enumerate every org's job rows.
		const read = await verifyRunnerMayReadJob(runnerId, jobId);
		if (read.error) return read.error;

		const db = getServiceDb();
		if (read.access === "applies_plan") {
			// The applying runner checks the plan's outcome, its kind (an apply plan for a DEPLOY, a
			// destroy plan for a DESTROY) and the configuration it was made from; it is given those
			// fields, not the plan job's snapshot or metadata.
			const [plan] = await db
				.select({
					id: jobs.id,
					job_type: jobs.job_type,
					status: jobs.status,
					project_id: jobs.project_id,
					environment_id: jobs.environment_id,
					configuration_hash: jobs.configuration_hash,
					plan_sha256: jobs.plan_sha256,
					destroy_plan: jobs.destroy_plan,
				})
				.from(jobs)
				.where(eq(jobs.id, jobId))
				.limit(1);
			if (!plan) {
				return NextResponse.json({ error: "Job not found" }, { status: 404 });
			}
			return NextResponse.json(plan);
		}

		const [job] = await db
			.select()
			.from(jobs)
			.where(eq(jobs.id, jobId))
			.limit(1);

		if (!job) {
			return NextResponse.json({ error: "Job not found" }, { status: 404 });
		}

		return NextResponse.json(job);
	} catch (err: unknown) {
		const message =
			err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
