// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { resolveAccountId } from "@/lib/auth/accounts";
import { getServiceDb } from "@/lib/db";
import { compareChartVersions } from "@/lib/addons/update-notice";
import { type ProvisionJobType, jobs, projectAddons, projectRepositories, runners } from "@/lib/db/schema";
import {
	type GitProviderRefusal,
	repoHostForLog,
	resolveGitProvider,
	UNPARSED_REPO_HOST,
} from "@/lib/git/provider-host";
import { verifyRunnerToken } from "@/lib/runners/auth";

/**
 * The refusal body for a repo whose host is not one of the configured git providers. `host` is the
 * hostname the resolver read (always hostname-shaped), or null when none could be read, in which case
 * the body names no host at all.
 */
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

/**
 * The source repo URLs of a BUILD job's repo-sourced services, read from its config snapshot
 * (`services[].source.repo_url` where `source.kind` is "repo"). The runner clones each one to pin the
 * commit it builds, so each is a repo this job legitimately asks a token for.
 */
function buildServiceRepos(snapshot: Record<string, unknown>): string[] {
	const services = snapshot.services;
	if (!Array.isArray(services)) return [];
	const repos: string[] = [];
	for (const service of services) {
		if (typeof service !== "object" || service === null || !("source" in service)) continue;
		const source = service.source;
		if (
			typeof source === "object" &&
			source !== null &&
			"kind" in source &&
			source.kind === "repo" &&
			"repo_url" in source &&
			typeof source.repo_url === "string" &&
			source.repo_url.length > 0
		) {
			repos.push(source.repo_url);
		}
	}
	return repos;
}

/** Marks a job that references more than one repo when the runner named none. */
const AMBIGUOUS = Symbol("ambiguous");

/** The job types whose runner clones only the snapshot's flat `repo_url` with an unnamed token. */
const FLAT_TARGET_JOB_TYPES: ReadonlySet<ProvisionJobType> = new Set<ProvisionJobType>([
	"CHART_SCAN",
	"IAC_SCAN",
	"ANALYZE_REPO",
]);

/**
 * The first runner release that never applies the unnamed token to a BYO git chart repo. Older
 * runners use it for a chart repo whose own token they could not get.
 */
const NAMED_CHART_TOKENS_SINCE = "0.10.0";

/**
 * Whether a runner reporting `version` may still use an unnamed token for a BYO git chart repo:
 * true below {@link NAMED_CHART_TOKENS_SINCE}, and true when the version is missing or is not a
 * SemVer version, since nothing then shows the runner is new enough.
 */
function mayReuseUnnamedTokenForCharts(version: string | null | undefined): boolean {
	if (!version) return true;
	const order = compareChartVersions(version, NAMED_CHART_TOKENS_SINCE);
	return order === null || order < 0;
}

/**
 * The version a runner request reports in its `User-Agent: runner/<version>` header (every runner
 * release that calls this route sends it), or null when the header is absent or has another shape.
 */
function requestRunnerVersion(req: Request): string | null {
	const match = /^runner\/(\S+)/.exec(req.headers.get("user-agent") ?? "");
	return match?.[1] ?? null;
}

/** The version the runner last reported on its heartbeat (`runners.version`), or null if none. */
async function recordedRunnerVersion(runnerId: string): Promise<string | null> {
	const [row] = await getServiceDb()
		.select({ version: runners.version })
		.from(runners)
		.where(eq(runners.id, runnerId))
		.limit(1);
	return row?.version ?? null;
}

/**
 * The repos a runner that names no repo (0.10.0 and older) uses the unnamed token for, by job type:
 *   - CHART_SCAN / IAC_SCAN / ANALYZE_REPO: the flat scan target only;
 *   - PLAN / DETECT_DRIFT: the BYO IaC module only (a plan returns before any GitOps step, and drift clones
 *     nothing else); one with no module falls back to every repo the job references;
 *   - DEPLOY: the IaC module and the apps repo, as the snapshot froze it and as the project holds it
 *     now (they differ when the apps repo changed after the job was queued), plus each BYO git chart
 *     repo when the runner may reuse the token for charts;
 *   - any other type: every repo the job references.
 */
function unnamedTokenRepos(
	jobType: ProvisionJobType,
	snapshot: Record<string, unknown>,
	liveAppsRepo: string,
	includeChartRepos: boolean,
): string[] {
	const allReferenced = [iacSourceRepo(snapshot), flatRepo(snapshot), snapshotAppsRepo(snapshot), liveAppsRepo];
	if (FLAT_TARGET_JOB_TYPES.has(jobType)) return [flatRepo(snapshot)];
	if (jobType === "PLAN" || jobType === "DETECT_DRIFT") {
		const iac = iacSourceRepo(snapshot);
		return iac ? [iac] : allReferenced;
	}
	if (jobType === "DEPLOY") {
		return [
			iacSourceRepo(snapshot),
			snapshotAppsRepo(snapshot),
			liveAppsRepo,
			...(includeChartRepos ? snapshotGitChartRepos(snapshot) : []),
		];
	}
	return allReferenced;
}

/**
 * The repo a request WITHOUT `?repo=` is answered for: the one distinct repo among `repos` (see
 * {@link unnamedTokenRepos}), "" when there is none, or {@link AMBIGUOUS} when there are several,
 * since an unnamed token would then be used for more than the repo it was minted for.
 */
function singleUnnamedRepo(repos: string[]): string | typeof AMBIGUOUS {
	const distinct = new Set(repos.filter((r) => r.length > 0));
	if (distinct.size > 1) return AMBIGUOUS;
	const [only] = distinct;
	return only ?? "";
}

/** The apps repo the snapshot froze at enqueue, under `repositories.apps_destination_repo`, or "". */
function snapshotAppsRepo(snapshot: Record<string, unknown>): string {
	const repositories = snapshot.repositories;
	return typeof repositories === "object" &&
		repositories !== null &&
		"apps_destination_repo" in repositories &&
		typeof repositories.apps_destination_repo === "string"
		? repositories.apps_destination_repo
		: "";
}

/** The chart repos of the snapshot's git-source add-ons (`addons[].chartRepo` where `source` is "git"). */
function snapshotGitChartRepos(snapshot: Record<string, unknown>): string[] {
	const addons = snapshot.addons;
	if (!Array.isArray(addons)) return [];
	const repos: string[] = [];
	for (const addon of addons) {
		if (
			typeof addon === "object" &&
			addon !== null &&
			"source" in addon &&
			addon.source === "git" &&
			"chartRepo" in addon &&
			typeof addon.chartRepo === "string"
		) {
			repos.push(addon.chartRepo);
		}
	}
	return repos;
}

/** The BYO IaC module repo a PLAN/DEPLOY/DESTROY/DRIFT snapshot carries under `iac_source`, or "". */
function iacSourceRepo(snapshot: Record<string, unknown>): string {
	const source = snapshot.iac_source;
	return typeof source === "object" &&
		source !== null &&
		"repo_url" in source &&
		typeof source.repo_url === "string"
		? source.repo_url
		: "";
}

/** The flat `repo_url` an ANALYZE_REPO / CHART_SCAN / IAC_SCAN snapshot names as its target, or "". */
function flatRepo(snapshot: Record<string, unknown>): string {
	return typeof snapshot.repo_url === "string" ? snapshot.repo_url : "";
}

/**
 * Returns the git provider token for the user who owns a job, minted for one repo of that job, as
 * `{ token, provider }`: `provider` is the git provider the repo's host resolved to, which the
 * runner's git client needs to pick the username it sends with the token.
 */
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
				job_type: jobs.job_type,
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

		// ANALYZE_REPO / CHART_SCAN / IAC_SCAN jobs carry their target repo as the flat
		// config_snapshot.repo_url. ANALYZE_REPO has no project; CHART_SCAN and IAC_SCAN DO carry a
		// project_id, so the project's apps repo is loaded for them too and is not their target.
		const scanRepoUrl = flatRepo(job.config_snapshot);
		// BYO IaC PLAN/DEPLOY/DESTROY/DRIFT jobs: the customer's module repo rides the snapshot under
		// iac_source — it's the repo the runner clones (replace mode).
		const iacRepoUrl = iacSourceRepo(job.config_snapshot);
		// Per-repo resolution: the runner names the exact repo it will clone or push with the token
		// it asks for — ?repo=<url> — for every clone (the IaC module, the apps repo, each BYO chart,
		// a scan target, a build's service source), so each token is minted for that one repo.
		// We only honor it when the repo is one this job legitimately references (a compromised
		// runner must not be able to phish a token for an arbitrary repo), and a repo outside that set
		// is REFUSED — never answered with the default repo's token, which the runner would then use
		// for the repo it asked about (#6600). BYO chart repos live on project_addons.chart_repo; a
		// BUILD job's service source repos ride its snapshot.
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
				...(job.job_type === "BUILD" ? buildServiceRepos(job.config_snapshot) : []),
			].filter((r): r is string => typeof r === "string" && r.length > 0),
		);

		if (requestedRepo && !authorizedRepos.has(requestedRepo)) {
			console.warn(
				`git-token: refused for job ${jobId} — requested repo (host ${repoHostForLog(requestedRepo)}) is not one this job references`,
			);
			return NextResponse.json(
				{
					error: "The requested repository is not one this job references; no git token was issued.",
					code: "git_repo_not_authorized",
				},
				{ status: 403 },
			);
		}

		// No ?repo= is the request runners up to 0.10.0 still send for a deploy, plan, drift, scan or
		// analyze job, and they use the token for every repo of that job type they clone or push (see
		// unnamedTokenRepos). So the token is minted only when that set holds exactly ONE repo, and is
		// then used for that repo alone. Otherwise no token is issued; a runner that names the repo
		// never reaches this path. Whether a DEPLOY's chart repos count depends on the runner's
		// version, read only on this path. Both the version this request reports and the one the
		// runner row last recorded must be new enough: the row is per runner, not per process, so
		// during a rolling update an older process can share a row a newer one already updated.
		const includeChartRepos =
			!requestedRepo &&
			job.job_type === "DEPLOY" &&
			(mayReuseUnnamedTokenForCharts(requestRunnerVersion(req)) ||
				mayReuseUnnamedTokenForCharts(await recordedRunnerVersion(runnerId)));
		const repoUrl =
			requestedRepo ||
			singleUnnamedRepo(
				unnamedTokenRepos(
					job.job_type,
					job.config_snapshot,
					repos?.apps_destination_repo ?? "",
					includeChartRepos,
				),
			);
		if (repoUrl === AMBIGUOUS) {
			console.warn(
				`git-token: refused for job ${jobId} — no repo named, and the job uses more than one repo`,
			);
			return NextResponse.json(
				{
					error: "This runner (0.10.0 or older) asks for one git token per job, and this job uses more than one repository, so no token was issued and a private repository will fail to clone. Upgrade the runner to a newer release.",
					code: "git_repo_required",
				},
				{ status: 400 },
			);
		}
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
				`git-token: refused for job ${jobId} — repo provider unresolved (${resolved.reason}, host ${resolved.host ?? UNPARSED_REPO_HOST})`,
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
					`git-token: job owner ${job.user_id} has no ${gitProvider} account link (repo host ${resolved.host}) — a PRIVATE apps repo cannot be cloned`,
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
					`git-token: no ${gitProvider} access token for job owner ${job.user_id} (repo host ${resolved.host}) — the owner has no valid ${gitProvider} link or its token could not be refreshed`,
				);
			}
			// The provider rides back with the token: it decides the username the runner's git client
			// sends with it (Bitbucket refuses GitHub's `x-access-token`, #6599), and only the console
			// can resolve it — a self-hosted GitLab host is configured here, not on the runner.
			return NextResponse.json({ token: res.accessToken ?? null, provider: gitProvider });
		} catch (err: unknown) {
			// getAccessToken threw (provider not configured, no account row, refresh failed, …).
			// Surface the reason — the swallowed catch here is what made this un-diagnosable.
			console.error(
				`git-token: getAccessToken failed for job owner ${job.user_id} provider ${gitProvider} (repo host ${resolved.host}):`,
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
