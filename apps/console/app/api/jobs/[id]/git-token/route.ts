// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { resolveAccountId } from "@/lib/auth/accounts";
import { getServiceDb } from "@/lib/db";
import { jobs, projectAddons, projectRepositories } from "@/lib/db/schema";
import { type GitProviderRefusal, resolveGitProvider } from "@/lib/git/provider-host";
import { verifyRunnerToken } from "@/lib/runners/auth";

/** The refusal body for a repo whose host is not one of the configured git providers. */
function unknownProviderResponse(
	reason: GitProviderRefusal,
	host: string | null,
): NextResponse {
	const what = host ? `host ${host}` : "this repository URL";
	return NextResponse.json(
		{
			error: `Cannot tell which git provider serves ${what}; no git token was issued. Supported hosts are github.com, bitbucket.org and the configured GitLab host.`,
			code: "git_provider_unresolved",
			reason,
		},
		{ status: 422 },
	);
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
		// No repo at all means nothing to clone, so there is nothing to authenticate: answer with no
		// token rather than guessing a provider. Every runner caller already treats a null token as
		// "clone anonymously".
		if (!repoUrl) return NextResponse.json({ token: null });

		// The provider decides WHOSE token leaves the console, so it is resolved from the repo's exact
		// host against the configured ones (#6600). An unknown host is refused, never defaulted — a
		// default would send one provider's token toward another provider's host.
		const resolved = resolveGitProvider(repoUrl);
		if (!resolved.ok) {
			console.warn(
				`git-token: refused for job ${jobId} — repo provider unresolved (${resolved.reason}${resolved.host ? `, host ${resolved.host}` : ""})`,
			);
			return unknownProviderResponse(resolved.reason, resolved.host);
		}
		const gitProvider = resolved.provider;

		// Better Auth returns a fresh (auto-refreshed) token from the owner's linked `account`,
		// keyed by the job owner's userId — this is a server-to-server call with no user session.
		//
		// We MUST NOT pass a `headers` object here. Better Auth's resolveUserId does:
		//   if (!session && (ctx.request || ctx.headers)) throw UNAUTHORIZED;
		//   const resolvedUserId = session?.user?.id || userId;
		// An empty `new Headers()` is still truthy, so passing it made resolveUserId throw
		// UNAUTHORIZED (no session on empty headers) BEFORE it ever fell back to the body `userId`
		// — the runner then got a null token and every PRIVATE apps-repo GitOps deploy failed with
		// "no git access token". Omitting headers makes `(ctx.request || ctx.headers)` falsy, so the
		// explicit `userId` path runs as intended.
		try {
			// 1.7 changed the selector from the provider id to the LOCAL account.id, and rejects
			// `providerId` outright. There is no server-side helper that maps one to the other, and
			// listUserAccounts is session-authenticated — which this call deliberately is not (see
			// the headers note above) — so resolve it straight from the account table.
			const accountId = await resolveAccountId(job.user_id, gitProvider);
			if (accountId === null) {
				console.warn(
					`git-token: job owner ${job.user_id} has no ${gitProvider} account link (repo ${repoUrl}) — a PRIVATE apps repo cannot be cloned`,
				);
				return NextResponse.json({ token: null });
			}
			const res = await auth.api.getAccessToken({
				body: { accountId, userId: job.user_id },
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
