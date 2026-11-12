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
function seed(appsRepo: string | null, chartRepos: string[] = []) {
	rowsByTable = new Map<unknown, unknown[]>([
		[
			jobs,
			[{ user_id: "user-1", project_id: "proj-1", runner_id: RUNNER, config_snapshot: {} }],
		],
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

	it("answers a job with no repo with no token, and never guesses a provider", async () => {
		seed(null);
		const res = await post();
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ token: null });
		expect(resolveAccountId).not.toHaveBeenCalled();
		expect(getAccessToken).not.toHaveBeenCalled();
	});
});
