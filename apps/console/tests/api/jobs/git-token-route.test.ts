// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// Pins which provider's token POST /api/jobs/[id]/git-token hands a runner (#6600). The provider is
// resolved from the job repo's exact host against the configured ones; a repo on any other host gets a
// 422 and NO token — the route never looks up an account link or asks Better Auth for a token, so no
// provider's token can be sent toward a host that is not that provider's.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { jobs, projectAddons, projectRepositories, runners } from "@/lib/db/schema";

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

/**
 * Seeds a job owned by RUNNER whose project's apps-destination repo is `appsRepo`. RUNNER reports
 * `runnerVersion` (null: no runners row, so no recorded version).
 */
function seed(
	appsRepo: string | null,
	chartRepos: string[] = [],
	job: { job_type: string; config_snapshot: Record<string, unknown> } = {
		job_type: "DEPLOY",
		config_snapshot: {},
	},
	runnerVersion: string | null = "0.10.0",
) {
	rowsByTable = new Map<unknown, unknown[]>([
		[jobs, [{ user_id: "user-1", project_id: "proj-1", runner_id: RUNNER, ...job }]],
		[projectRepositories, appsRepo === null ? [] : [{ apps_destination_repo: appsRepo }]],
		[projectAddons, chartRepos.map((chart_repo) => ({ chart_repo }))],
		[runners, runnerVersion === null ? [] : [{ version: runnerVersion }]],
	]);
}

/** The `User-Agent` the next request sends (every runner release sends `runner/<version>`); null sends none. */
let userAgent: string | null = "runner/0.10.0";

/** Invokes the route, optionally asking for a specific repo's token. */
async function post(repo?: string) {
	const { POST } = await import("@/app/api/jobs/[id]/git-token/route");
	const query = repo ? `?repo=${encodeURIComponent(repo)}` : "";
	const headers: Record<string, string> = userAgent === null ? {} : { "user-agent": userAgent };
	return POST(new Request(`https://console.local/api/jobs/job-1/git-token${query}`, { method: "POST", headers }), {
		params: Promise.resolve({ id: "job-1" }),
	});
}

beforeEach(() => {
	userAgent = "runner/0.10.0";
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
		const APPS = "https://github.com/acme/apps";
		const IAC = "https://bitbucket.org/acme/infra";
		const TARGET = "https://github.com/acme/chart";
		const CHART = "https://code.acme.example/acme/byo-chart";

		/** What one unnamed request did: its status, its code, and whether any account was read or token minted. */
		async function unnamedOutcome() {
			const res = await post();
			const body = await res.text();
			const parsed: { code?: string } = JSON.parse(body);
			return {
				status: res.status,
				code: parsed.code ?? null,
				tokenInBody: body.includes(TOKEN),
				accountLookups: resolveAccountId.mock.calls,
				mints: getAccessToken.mock.calls.length,
			};
		}

		/** A 400 git_repo_required that minted nothing and looked up no account. */
		const REFUSED = { status: 400, code: "git_repo_required", tokenInBody: false, accountLookups: [], mints: 0 };

		/** A 200 carrying the token, minted once from `provider`'s link. */
		function minted(provider: string) {
			return { status: 200, code: null, tokenInBody: true, accountLookups: [["user-1", provider]], mints: 1 };
		}

		it("tells the operator the consequence and the fix, and names no repo", async () => {
			seed(APPS, [], { job_type: "DEPLOY", config_snapshot: { iac_source: { repo_url: IAC } } });
			const res = await post();
			const { error } = await res.json();
			expect(error).toContain("will fail to clone");
			expect(error).toContain("Upgrade the runner");
			expect(error).not.toContain("github.com/acme");
			expect(error).not.toContain("bitbucket");
		});

		describe.each(["CHART_SCAN", "IAC_SCAN", "ANALYZE_REPO"])("%s", (jobType) => {
			it("is answered for the scan target even when the project has a different apps repo", async () => {
				seed(APPS, [], {
					job_type: jobType,
					config_snapshot: { repo_url: IAC, repositories: { apps_destination_repo: APPS } },
				});
				expect(await unnamedOutcome()).toEqual(minted("bitbucket"));
			});

			it("answers no token when the snapshot names no scan target", async () => {
				seed(APPS, [], { job_type: jobType, config_snapshot: {} });
				const res = await post();
				expect(res.status).toBe(200);
				expect(await res.json()).toEqual({ token: null });
				expect(resolveAccountId).not.toHaveBeenCalled();
			});
		});

		describe.each(["PLAN", "DETECT_DRIFT"])("%s", (jobType) => {
			it("is answered for the IaC module even when the apps repo differs", async () => {
				seed(APPS, [CHART], {
					job_type: jobType,
					config_snapshot: {
						iac_source: { repo_url: IAC },
						repositories: { apps_destination_repo: APPS },
						addons: [{ id: "c", source: "git", chartRepo: CHART }],
					},
				}, "0.9.0");
				expect(await unnamedOutcome()).toEqual(minted("bitbucket"));
			});

			it("with no IaC module, is refused when the job references more than one repo", async () => {
				seed(APPS, [], {
					job_type: jobType,
					config_snapshot: { repositories: { apps_destination_repo: "https://github.com/acme/old-apps" } },
				});
				expect(await unnamedOutcome()).toEqual(REFUSED);
			});

			it("with no IaC module, is answered for the job's one repo", async () => {
				seed(APPS, [], { job_type: jobType, config_snapshot: { repositories: { apps_destination_repo: APPS } } });
				expect(await unnamedOutcome()).toEqual(minted("github"));
			});
		});

		describe("DEPLOY", () => {
			it("is refused when the module and the apps repo differ", async () => {
				seed(APPS, [], { job_type: "DEPLOY", config_snapshot: { iac_source: { repo_url: IAC } } });
				expect(await unnamedOutcome()).toEqual(REFUSED);
			});

			it("is refused when the snapshot's apps repo differs from the project's current one", async () => {
				seed(APPS, [], {
					job_type: "DEPLOY",
					config_snapshot: { repositories: { apps_destination_repo: "https://github.com/acme/old-apps" } },
				});
				expect(await unnamedOutcome()).toEqual(REFUSED);
			});

			it("is answered when the module IS the apps repo, so the token serves one repo", async () => {
				const repo = "https://github.com/acme/mono";
				seed(repo, [], {
					job_type: "DEPLOY",
					config_snapshot: { iac_source: { repo_url: repo }, repositories: { apps_destination_repo: repo } },
				});
				expect(await unnamedOutcome()).toEqual(minted("github"));
			});

			/** A DEPLOY whose only module/apps repo is APPS, with one BYO git chart on CHART. */
			const chartDeploy = {
				job_type: "DEPLOY",
				config_snapshot: {
					repositories: { apps_destination_repo: APPS },
					addons: [
						{ id: "byo", source: "git", chartRepo: CHART },
						{ id: "grafana", source: "helm", chartRepo: "https://grafana.github.io/helm-charts" },
					],
				},
			};

			it.each(["0.10.0", "v0.10.0", "0.11.2"])(
				"from runner %s, still answers for the apps repo when a BYO chart lives elsewhere",
				async (version) => {
					userAgent = `runner/${version}`;
					seed(APPS, [CHART], chartDeploy, version);
					expect(await unnamedOutcome()).toEqual(minted("github"));
				},
			);

			it.each([
				["0.9.0", "0.9.0"],
				["a pre-release of 0.10.0", "0.10.0-rc.1"],
				["a version that is not SemVer", "dev"],
				["an empty version", ""],
				["no recorded version", null],
			])("from a runner reporting %s, is refused when a BYO git chart lives elsewhere", async (_what, version) => {
				seed(APPS, [CHART], chartDeploy, version);
				expect(await unnamedOutcome()).toEqual(REFUSED);
			});

			it.each([
				["reports 0.9.0 while the row already says 0.10.0 (a rolling update)", "runner/0.9.0"],
				["sends no User-Agent", null],
				["sends a User-Agent of another shape", "Go-http-client/1.1"],
			])("from a request that %s, is refused when a BYO git chart lives elsewhere", async (_what, ua) => {
				userAgent = ua;
				seed(APPS, [CHART], chartDeploy, "0.10.0");
				expect(await unnamedOutcome()).toEqual(REFUSED);
			});

			it("from an old runner, ignores a chart that is not git-sourced", async () => {
				seed(APPS, [], {
					job_type: "DEPLOY",
					config_snapshot: {
						repositories: { apps_destination_repo: APPS },
						addons: [{ id: "grafana", source: "helm", chartRepo: "https://grafana.github.io/helm-charts" }],
					},
				}, "0.9.0");
				expect(await unnamedOutcome()).toEqual(minted("github"));
			});
		});

		it("is refused for a job type with no per-type rule when it references more than one repo", async () => {
			seed(APPS, [], { job_type: "DESTROY", config_snapshot: { iac_source: { repo_url: IAC } } });
			expect(await unnamedOutcome()).toEqual(REFUSED);
		});

		it("is refused for another job type whose snapshot names both a scan target and a module", async () => {
			seed(null, [], { job_type: "STATE_SURGERY", config_snapshot: { repo_url: TARGET, iac_source: { repo_url: IAC } } });
			expect(await unnamedOutcome()).toEqual(REFUSED);
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
