// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getServiceDb } from "@/lib/db";
import { jobs, specRepositories } from "@/lib/db/schema";
import type { GitProvider as PublicGitProvider } from "@/lib/db/schema";
import { verifyWorkerToken } from "@/lib/workers/auth";

/** Returns the git provider token for the user who owns a job. */
export async function POST(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { workerId, error: authError } = await verifyWorkerToken(req);
	if (authError) return authError;

	const { id: jobId } = await params;

	try {
		const db = getServiceDb();

		// Look up the job and verify the calling worker owns it.
		const [job] = await db
			.select({
				user_id: jobs.user_id,
				spec_id: jobs.spec_id,
				runner_id: jobs.runner_id,
			})
			.from(jobs)
			.where(eq(jobs.id, jobId))
			.limit(1);

		if (!job) {
			return NextResponse.json({ error: "Job not found" }, { status: 404 });
		}

		if (job.runner_id !== workerId) {
			return NextResponse.json(
				{ error: "Worker does not own this job" },
				{ status: 403 },
			);
		}

		// Determine the git provider from the spec's repository URL.
		const [repos] = job.spec_id
			? await db
					.select({
						apps_destination_repo: specRepositories.apps_destination_repo,
					})
					.from(specRepositories)
					.where(eq(specRepositories.spec_id, job.spec_id))
					.limit(1)
			: [];

		const repoUrl = repos?.apps_destination_repo || "";
		const gitProvider: PublicGitProvider = repoUrl.includes("gitlab")
			? "gitlab"
			: repoUrl.includes("bitbucket")
				? "bitbucket"
				: "github";

		// Better Auth returns a fresh (auto-refreshed) token from the owner's
		// linked `account`. No session needed — keyed by the job owner's userId.
		try {
			const res = await auth.api.getAccessToken({
				body: { providerId: gitProvider, userId: job.user_id },
				headers: new Headers(),
			});
			return NextResponse.json({ token: res.accessToken ?? null });
		} catch {
			return NextResponse.json({ token: null });
		}
	} catch (err: unknown) {
		console.error("Git token fetch error:", err);
		return NextResponse.json(
			{ error: "Internal Server Error" },
			{ status: 500 },
		);
	}
}
