// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Mints the per-job, key-scoped state bearer the runner puts in TF_HTTP_PASSWORD for the tofu-state
// proxy (E0). Runner-authed (X-Runner-*) + job-ownership; the state key is derived server-side from the
// job so the runner can't influence which state object the token grants.

import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getServiceDb } from "@/lib/db";
import { jobs } from "@/lib/db/schema";
import { verifyRunnerOwnsJob, verifyRunnerToken } from "@/lib/runners/auth";
import { mintStateToken } from "@/lib/runners/state-token";
import { stateKeyForJob } from "@/lib/storage/tofu-state";

export const runtime = "nodejs";

export async function POST(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { runnerId, error: authError } = await verifyRunnerToken(req);
	if (authError) return authError;

	const { id: jobId } = await params;
	const ownershipError = await verifyRunnerOwnsJob(runnerId, jobId);
	if (ownershipError) return ownershipError;

	const db = getServiceDb();
	const [job] = await db
		.select({
			job_type: jobs.job_type,
			project_id: jobs.project_id,
			environment_id: jobs.environment_id,
			config_snapshot: jobs.config_snapshot,
		})
		.from(jobs)
		.where(eq(jobs.id, jobId))
		.limit(1);

	if (!job) {
		return NextResponse.json({ error: "Job not found" }, { status: 404 });
	}
	const key = stateKeyForJob(job);
	if ("error" in key) {
		return NextResponse.json({ error: key.error }, { status: key.status });
	}

	const token = await mintStateToken({ jobId, stateKey: key.key });
	return NextResponse.json({ token });
}
