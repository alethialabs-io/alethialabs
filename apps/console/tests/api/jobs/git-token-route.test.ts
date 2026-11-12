// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// Pins which provider's token POST /api/jobs/[id]/git-token hands a runner (#6600). The provider is
// resolved from the job repo's exact host against the configured ones; a repo on any other host gets a
// 422 and NO token — the route never looks up an account link or asks Better Auth for a token, so no
// provider's token can be sent toward a host that is not that provider's.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { jobs, projectAddons, projectRepositories } from "@/lib/db/schema";

const RUNNER = "11111111-1111-1111-1111-111111111111";
const TOKEN = "CANARY-git-token-5d1e";

const verifyRunnerToken = vi.fn();
vi.mock("@/lib/runners/auth", () => ({
	verifyRunnerToken: (req: Request) => verifyRunnerToken(req),
}));

const resolveAccountId = vi.fn();
vi.mock("@/lib/auth/accounts", () => ({
	resolveAccountId: (userId: string, providerId: string) =>
		resolveAccountId(userId, providerId),
}));

const getAccessToken = vi.fn();
vi.mock("@/lib/auth", () => ({
	auth: { api: { getAccessToken: (input: unknown) => getAccessToken(input) } },
}));

vi.mock("@/lib/config/auth", () => ({
	getGitlabBaseUrl: () => "https://code.acme.example",
}));

/** The rows each table's SELECT resolves to. */
let rowsByTable = new Map<unknown, unknown[]>();

/** A drizzle stand-in: `from(table)` picks the rows; `.limit()` and an awaited `.where()` resolve them. */
const fakeDb = {
	select: () => ({
		from: (table: unknown) => {
			const rows = rowsByTable.get(table) ?? [];
			return {
				where: () => {
					const terminal = { limit: () => Promise.resolve(rows) };
					return Object.assign(Promise.resolve(rows), terminal);
				},
			};
		},
	}),
};
vi.mock("@/lib/db", () => ({ getServiceDb: () => fakeDb }));

/** Seeds a job owned by RUNNER whose project's apps-destination repo is `appsRepo`. */
function seed(
	appsRepo: string | null,
	chartRepos: string[] = [],
	job: { job_type: string; config_snapshot: Record<string, unknown> } = {
		job_type: "DEPLOY",
		config_snapshot: {},
	},
) {
	rowsByTable = new Map<unknown, unknown[]>([
		[jobs, [{ user_id: "user-1", project_id: "proj-1", runner_id: RUNNER, ...job }]],
		[projectRepositories, appsRepo === null ? [] : [{ apps_destination_repo: appsRepo }]],
		[projectAddons, chartRepos.map((chart_repo) => ({ chart_repo }))],
	]);
}

/** Invokes the route, optionally asking for a specific repo's token. */
async function post(repo?: string) {
	const { POST } = await import("@/app/api/jobs/[id]/git-token/route");
	const query = repo ? `?repo=${encodeURIComponent(repo)}` : "";
	return POST(new Request(`https://console.local/api/jobs/job-1/git-token${query}`, { method: "POST" }), {
		params: Promise.resolve({ id: "job-1" }),
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	verifyRunnerToken.mockResolvedValue({ runnerId: RUNNER, tokenHash: "h" });
	resolveAccountId.mockResolvedValue("account-1");
	getAccessToken.mockResolvedValue({ accessToken: TOKEN });
});

describe("POST /api/jobs/[id]/git-token", () => {
	it.each([
		["https://github.com/acme/apps", "github"],
		["https://bitbucket.org/acme/apps", "bitbucket"],
		["https://code.acme.example/acme/apps", "gitlab"],
	])("mints the token for %s from the %s link", async (repo, provider) => {
		seed(repo);
		const res = await post();
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ token: TOKEN });
		expect(resolveAccountId).toHaveBeenCalledWith("user-1", provider);
	});

	it.each([
		"https://git.example.net/acme/apps",
		"https://code.acme.example.evil.io/acme/apps",
		"https://gitlab.com/acme/apps",
		"https://my-gitlab.evil.io/acme/apps",
	])("refuses %s with a 422 and no token", async (repo) => {
		seed(repo);
		const res = await post();
		expect(res.status).toBe(422);
		const body = await res.text();
		expect(body).not.toContain(TOKEN);
		expect(JSON.parse(body)).toMatchObject({ code: "git_provider_unresolved", reason: "unknown_host" });
		expect(resolveAccountId).not.toHaveBeenCalled();
		expect(getAccessToken).not.toHaveBeenCalled();
	});

	it("refuses a per-repo request for a BYO chart on an unknown host", async () => {
		seed("https://github.com/acme/apps", ["https://charts.example.net/acme/chart"]);
		const res = await post("https://charts.example.net/acme/chart");
		expect(res.status).toBe(422);
		expect(await res.text()).not.toContain(TOKEN);
		expect(getAccessToken).not.toHaveBeenCalled();
	});

	it("refuses a requested repo the job does not reference, instead of answering with the default repo's token", async () => {
		seed("https://github.com/acme/apps");
		const res = await post("https://github.com/someone-else/repo");
		expect(res.status).toBe(403);
		const body = await res.text();
		expect(body).not.toContain(TOKEN);
		expect(JSON.parse(body)).toMatchObject({ code: "git_repo_not_authorized" });
		expect(resolveAccountId).not.toHaveBeenCalled();
		expect(getAccessToken).not.toHaveBeenCalled();
	});

	/** A BUILD job whose snapshot carries one repo-sourced and one image-sourced service. */
	function buildJob(serviceRepo: string) {
		return {
			job_type: "BUILD",
			config_snapshot: {
				services: [
					{ name: "api", source: { kind: "repo", repo_url: serviceRepo, path: "." } },
					{ name: "db", source: { kind: "image", image: "postgres:16" } },
				],
			},
		};
	}

	it("mints the token for a BUILD job's service source repo on github.com", async () => {
		seed("https://bitbucket.org/acme/apps", [], buildJob("https://github.com/acme/api"));
		const res = await post("https://github.com/acme/api");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ token: TOKEN });
		expect(resolveAccountId).toHaveBeenCalledWith("user-1", "github");
	});

	it("refuses a BUILD job's service source repo on an unknown host", async () => {
		seed("https://github.com/acme/apps", [], buildJob("https://git.example.net/acme/api"));
		const res = await post("https://git.example.net/acme/api");
		expect(res.status).toBe(422);
		expect(await res.text()).not.toContain(TOKEN);
		expect(getAccessToken).not.toHaveBeenCalled();
	});

	it("does not authorize service repos for a job that is not a BUILD", async () => {
		seed("https://github.com/acme/apps", [], {
			...buildJob("https://github.com/acme/api"),
			job_type: "DEPLOY",
		});
		const res = await post("https://github.com/acme/api");
		expect(res.status).toBe(403);
		expect(getAccessToken).not.toHaveBeenCalled();
	});

	describe("each runner path names its repo and gets that repo's provider", () => {
		const IAC = "https://bitbucket.org/acme/infra";
		const APPS = "https://github.com/acme/apps";
		const iacDeploy = { job_type: "DEPLOY", config_snapshot: { iac_source: { repo_url: IAC } } };

		it.each([
			["the BYO IaC module", IAC, "bitbucket"],
			["the apps repo", APPS, "github"],
		])("deploy: mints the token for %s from its own provider", async (_what, repo, provider) => {
			seed(APPS, [], iacDeploy);
			const res = await post(repo);
			expect(res.status).toBe(200);
			expect(resolveAccountId).toHaveBeenCalledWith("user-1", provider);
		});

		it("deploy: mints a BYO chart's token from the chart repo's provider", async () => {
			seed(APPS, ["https://code.acme.example/acme/chart"]);
			const res = await post("https://code.acme.example/acme/chart");
			expect(res.status).toBe(200);
			expect(resolveAccountId).toHaveBeenCalledWith("user-1", "gitlab");
		});

		it.each(["CHART_SCAN", "IAC_SCAN"])(
			"%s: mints the token for the scan target, not for the project's apps repo",
			async (jobType) => {
				seed(APPS, [], { job_type: jobType, config_snapshot: { repo_url: IAC } });
				const res = await post(IAC);
				expect(res.status).toBe(200);
				expect(resolveAccountId).toHaveBeenCalledWith("user-1", "bitbucket");
			},
		);
	});

	describe("a request that names no repo (runners up to 0.10.0)", () => {
		it.each([
			[
				"a BYO IaC deploy whose module and apps repo differ",
				{ job_type: "DEPLOY", config_snapshot: { iac_source: { repo_url: "https://bitbucket.org/acme/infra" } } },
			],
			["a CHART_SCAN of a repo that is not the apps repo", { job_type: "CHART_SCAN", config_snapshot: { repo_url: "https://github.com/acme/chart" } }],
			["an IAC_SCAN of a repo that is not the apps repo", { job_type: "IAC_SCAN", config_snapshot: { repo_url: "https://github.com/acme/infra" } }],
		])("is refused for %s, with no token minted", async (_what, job) => {
			seed("https://github.com/acme/apps", [], job);
			const res = await post();
			expect(res.status).toBe(400);
			const body = await res.text();
			expect(body).not.toContain(TOKEN);
			expect(JSON.parse(body)).toMatchObject({ code: "git_repo_required" });
			expect(resolveAccountId).not.toHaveBeenCalled();
			expect(getAccessToken).not.toHaveBeenCalled();
		});

		it("is answered for a job whose only repo is the scan target (ANALYZE_REPO has no project)", async () => {
			seed(null, [], { job_type: "ANALYZE_REPO", config_snapshot: { repo_url: "https://bitbucket.org/acme/svc" } });
			const res = await post();
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ token: TOKEN });
			expect(resolveAccountId).toHaveBeenCalledWith("user-1", "bitbucket");
		});

		it("is answered when the BYO IaC module IS the apps repo, so the token serves one repo", async () => {
			const repo = "https://github.com/acme/mono";
			seed(repo, [], { job_type: "DEPLOY", config_snapshot: { iac_source: { repo_url: repo } } });
			const res = await post();
			expect(res.status).toBe(200);
			expect(resolveAccountId).toHaveBeenCalledWith("user-1", "github");
		});
	});

	it("names no host text from a repo URL whose host cannot be read", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		seed("git@tok-5d1e@evil.example:acme/apps.git");
		const res = await post();
		expect(res.status).toBe(422);
		const body = await res.text();
		expect(JSON.parse(body)).toMatchObject({ reason: "malformed" });
		expect(body).not.toContain("tok-5d1e");
		expect(body).not.toContain("evil.example");
		const logged = warn.mock.calls.flat().join(" ");
		expect(logged).toContain("(unparsed repo URL)");
		expect(logged).not.toContain("tok-5d1e");
		warn.mockRestore();
	});

	it("answers a job with no repo with no token, and never guesses a provider", async () => {
		seed(null);
		const res = await post();
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ token: null });
		expect(resolveAccountId).not.toHaveBeenCalled();
		expect(getAccessToken).not.toHaveBeenCalled();
	});
});
