// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getServiceDb } from "@/lib/db";
import { jobs, projectRepositories } from "@/lib/db/schema";
import type { GitProvider as PublicGitProvider } from "@/lib/db/schema";
import { verifyRunnerToken } from "@/lib/runners/auth";

/** Returns the git provider token for the user who owns a job. */
export async function POST(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { runnerId, error: authError } = await verifyRunnerToken(req);
	if (authError) return authError;

	const { id: jobId } = await params;

	try {
		const db = getServiceDb();

		// Look up the job and verify the calling runner owns it.
		const [job] = await db
			.select({
				user_id: jobs.user_id,
				project_id: jobs.project_id,
				runner_id: jobs.runner_id,
				config_snapshot: jobs.config_snapshot,
			})
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

		// Determine the git provider from the project's repository URL.
		const [repos] = job.project_id
			? await db
					.select({
						apps_destination_repo: projectRepositories.apps_destination_repo,
					})
					.from(projectRepositories)
					.where(eq(projectRepositories.project_id, job.project_id))
					.limit(1)
			: [];

		// ANALYZE_REPO / CHART_SCAN / IAC_SCAN jobs have no project row — the target repo is the
		// flat config_snapshot.repo_url.
		const scanRepoUrl =
			typeof job.config_snapshot?.repo_url === "string"
				? job.config_snapshot.repo_url
				: "";
		// BYO IaC PLAN/DEPLOY/DESTROY jobs: the customer's module repo rides the snapshot under
		// iac_source — it's the repo the runner clones (replace mode), so it wins over the
		// project's GitOps destination repo for provider detection.
		const snapIacSource = job.config_snapshot?.iac_source;
		const iacRepoUrl =
			typeof snapIacSource === "object" &&
			snapIacSource !== null &&
			"repo_url" in snapIacSource &&
			typeof snapIacSource.repo_url === "string"
				? snapIacSource.repo_url
				: "";
		const repoUrl =
			iacRepoUrl || repos?.apps_destination_repo || scanRepoUrl || "";
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
