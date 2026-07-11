// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { getServiceDb } from "@/lib/db";
import { jobs } from "@/lib/db/schema";
import { verifyRunnerToken } from "@/lib/runners/auth";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

export async function GET(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { runnerId, error: authError } = await verifyRunnerToken(req);
	if (authError) return authError;

	const { id: jobId } = await params;

	try {
		const db = getServiceDb();
		const [job] = await db
			.select()
			.from(jobs)
			.where(eq(jobs.id, jobId))
			.limit(1);

		if (!job) {
			return NextResponse.json({ error: "Job not found" }, { status: 404 });
		}

		// A runner may only read jobs it owns — otherwise any valid runner token
		// could enumerate every org's job rows.
		if (job.runner_id !== runnerId) {
			return NextResponse.json(
				{ error: "Runner does not own this job" },
				{ status: 403 },
			);
		}

		return NextResponse.json(job);
	} catch (err: unknown) {
		const message =
			err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
