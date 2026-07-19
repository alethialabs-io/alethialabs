// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getServiceDb } from "@/lib/db";
import { jobs, projectAddons, projectRepositories } from "@/lib/db/schema";
import type { GitProvider as PublicGitProvider } from "@/lib/db/schema";
import { verifyRunnerToken } from "@/lib/runners/auth";

/** Detects the git provider from a repo URL (defaults to github). */
function providerFromRepo(repoUrl: string): PublicGitProvider {
	return repoUrl.includes("gitlab")
		? "gitlab"
		: repoUrl.includes("bitbucket")
			? "bitbucket"
			: "github";
}

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
		// Per-repo resolution: a runner asking for the token to clone a SPECIFIC repo — e.g. a BYO
		// Helm chart on a different provider than the apps-destination repo — passes ?repo=<url>.
		// We only honor it when the repo is one this job legitimately references (a compromised
		// runner must not be able to phish a token for an arbitrary repo); otherwise we fall back
		// to the default precedence below. BYO chart repos live on project_addons.chart_repo.
		const requestedRepo =
			new URL(req.url).searchParams.get("repo")?.trim() || "";
		const byoChartRepos =
			requestedRepo && job.project_id
				? await db
						.select({ chart_repo: projectAddons.chart_repo })
						.from(projectAddons)
						.where(eq(projectAddons.project_id, job.project_id))
				: [];
		const authorizedRepos = new Set(
			[
				repos?.apps_destination_repo,
				iacRepoUrl,
				scanRepoUrl,
				...byoChartRepos.map((r) => r.chart_repo),
			].filter((r): r is string => typeof r === "string" && r.length > 0),
		);

		const repoUrl =
			requestedRepo && authorizedRepos.has(requestedRepo)
				? requestedRepo
				: iacRepoUrl || repos?.apps_destination_repo || scanRepoUrl || "";
		const gitProvider: PublicGitProvider = providerFromRepo(repoUrl);

		// Better Auth returns a fresh (auto-refreshed) token from the owner's
		// linked `account`. No session needed — keyed by the job owner's userId.
		try {
			const res = await auth.api.getAccessToken({
				body: { providerId: gitProvider, userId: job.user_id },
				headers: new Headers(),
			});
			// A null token is the silent killer of a GitOps deploy (deploy.go's git-token gate) — so
			// say WHY out loud instead of returning an unexplained null. The commonest cause is the
			// job owner having no valid `${gitProvider}` account link (or one whose token can't be
			// refreshed): the runner then can't clone a PRIVATE apps repo. (A PUBLIC repo no longer
			// needs this — ArgoCD clones it anonymously.)
			if (!res.accessToken) {
				console.warn(
					`git-token: no ${gitProvider} access token for job owner ${job.user_id} (repo ${repoUrl}) — the owner has no valid ${gitProvider} link or its token could not be refreshed`,
				);
			}
			return NextResponse.json({ token: res.accessToken ?? null });
		} catch (err: unknown) {
			// getAccessToken threw (provider not configured, no account row, refresh failed, …).
			// Surface the reason — the swallowed catch here is what made this un-diagnosable.
			console.error(
				`git-token: getAccessToken failed for job owner ${job.user_id} provider ${gitProvider} (repo ${repoUrl}):`,
				err instanceof Error ? err.message : err,
			);
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
