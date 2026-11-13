// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The console side of the bump pull request (#6549): which hosts a token may go to, that the token
// is never in a response or a log line, and what is stored.

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The real token reader needs Better Auth; every test hands in its own reader instead.
vi.mock("@/lib/auth/provider-token", () => ({ providerTokenForUser: vi.fn(async () => null) }));

import { githubClient, githubRepoFromUrl } from "@/lib/addons/gitops-bump/github";
import {
	type GitopsBumpInput,
	type GitopsBumpStore,
	requestGitopsBumpFor,
} from "@/lib/addons/gitops-bump/service";
import type { GitopsBumpRecord } from "@/types/jsonb.types";

const TOKEN = "gho_SECRET_TOKEN_VALUE_6549";
const FIXTURES = resolve(__dirname, "../../../../../../packages/core/provisioner/testdata/addon_bump");
const SEEDED = readFileSync(join(FIXTURES, "plain.yaml"));

const INPUT: GitopsBumpInput = {
	actor: { userId: "user-1", orgId: "org-1", credential: "session" },
	projectId: "11111111-1111-4111-8111-111111111111",
	environmentId: "22222222-2222-4222-8222-222222222222",
	addonId: "ingress-nginx",
	again: false,
};

type Row = { mode: string; source: string; version: string | null; gitopsBump: GitopsBumpRecord | null };

/** An in-memory store: one GitOps ingress-nginx row pinned to 4.15.1, and the given apps repo. */
function store(appsRepo: string | null, row: Row | null = {
	mode: "gitops",
	source: "catalog",
	version: "4.15.1",
	gitopsBump: null,
}) {
	const saved: GitopsBumpRecord[] = [];
	const s: GitopsBumpStore = {
		readTarget: async () => ({ row, appsRepo }),
		saveBump: async (_input, record) => {
			saved.push(record);
		},
	};
	return { s, saved };
}

/** A GitHub that answers the happy path, recording every request it is sent. */
function fakeFetch(overrides: { status?: (url: string, method: string) => number | null } = {}) {
	const seen: { url: string; init: RequestInit }[] = [];
	let pulls: unknown[] = [];
	const fn = vi.fn(async (url: string, init: RequestInit) => {
		seen.push({ url, init });
		const method = init.method ?? "GET";
		const forced = overrides.status?.(url, method);
		const json = (status: number, body: unknown) =>
			new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
		// A provider error body that echoes the token: it must never be forwarded.
		if (forced) return json(forced, { message: `Bad credentials for ${TOKEN}` });
		const path = new URL(url).pathname.replace("/repos/acme/apps", "");
		if (method === "GET" && path === "") return json(200, { default_branch: "main" });
		if (method === "GET" && path === "/pulls") return json(200, pulls);
		if (method === "GET" && path.startsWith("/contents/")) {
			return new URL(url).searchParams.get("ref") === "main"
				? json(200, { encoding: "base64", content: SEEDED.toString("base64"), sha: "blob1" })
				: json(404, {});
		}
		if (method === "GET" && path === "/git/ref/heads/main") return json(200, { object: { sha: "c0ffee" } });
		if (method === "POST" && path === "/git/refs") return json(201, {});
		if (method === "PUT" && path.startsWith("/contents/")) return json(200, {});
		if (method === "POST" && path === "/pulls") {
			const pull = { number: 7, state: "open", html_url: "https://github.com/acme/apps/pull/7", merged_at: null };
			pulls = [pull];
			return json(201, pull);
		}
		return json(404, {});
	});
	return { fn, seen };
}

let logs: string[] = [];
beforeEach(() => {
	logs = [];
	const levels = ["log", "info", "warn", "error", "debug"] satisfies (keyof Console)[];
	for (const level of levels) {
		vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
			logs.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : JSON.stringify(a) ?? String(a))).join(" "));
		});
	}
});
afterEach(() => {
	vi.restoreAllMocks();
});

describe("requestGitopsBumpFor: the host allowlist (#6549)", () => {
	const reader = vi.fn(async () => TOKEN);
	beforeEach(() => {
		reader.mockClear();
	});

	const hosts: [string, string][] = [
		["https://gitlab.com/acme/apps.git", "provider-not-supported"],
		["git@bitbucket.org:acme/apps.git", "provider-not-supported"],
		["https://git.acme.internal/acme/apps.git", "unknown-host"],
		["https://evilgithub.com/acme/apps", "unknown-host"],
		["https://github.com.evil.io/acme/apps", "unknown-host"],
		["http://github.com/acme/apps", "unknown-host"],
		["https://github.com/acme", "unknown-host"],
		["https://github.com/acme/apps/tree/main", "unknown-host"],
		["https://github.com:8443/acme/apps", "unknown-host"],
	];
	it("names the port when the apps repo is github.com on another port", async () => {
		const { fn } = fakeFetch();
		const { s } = store("https://github.com:8443/acme/apps");
		const r = await requestGitopsBumpFor(s, INPUT, fn, reader);
		expect(r).toMatchObject({ status: "refused", reason: "unknown-host" });
		if (r.status !== "refused") throw new Error("unreachable");
		expect(r.message).toContain("on port 8443");
		expect(r.message).toContain("only served on port 443");
		expect(reader).not.toHaveBeenCalled();
	});

	for (const [repo, reason] of hosts) {
		it(`${repo} → ${reason}, and no token is read or sent`, async () => {
			const { fn } = fakeFetch();
			const { s, saved } = store(repo);
			const r = await requestGitopsBumpFor(s, INPUT, fn, reader);
			expect(r.status).toBe("refused");
			if (r.status !== "refused") throw new Error("unreachable");
			expect(r.reason).toBe(reason);
			// The manual instruction always comes with a refusal.
			expect(r).toMatchObject({ file: "addons/ingress-nginx.yaml", field: "spec.source.targetRevision", version: "4.15.1" });
			expect(reader).not.toHaveBeenCalled();
			expect(fn).not.toHaveBeenCalled();
			expect(saved).toEqual([]);
		});
	}

	it("github.com: the token is read for GitHub and sent ONLY to api.github.com, in the Authorization header", async () => {
		const { fn, seen } = fakeFetch();
		const { s, saved } = store("https://github.com/acme/apps.git");
		const r = await requestGitopsBumpFor(s, INPUT, fn, reader, () => new Date("2026-11-12T00:00:00Z"));
		expect(r).toMatchObject({ status: "open", created: true, number: 7, url: "https://github.com/acme/apps/pull/7" });
		expect(reader).toHaveBeenCalledWith("user-1", "github");
		expect(seen.length).toBeGreaterThan(0);
		for (const { url, init } of seen) {
			expect(new URL(url).origin).toBe("https://api.github.com");
			expect(url).not.toContain(TOKEN);
			expect(new Headers(init.headers).get("Authorization")).toBe(`Bearer ${TOKEN}`);
			expect(init.redirect).toBe("error");
			expect(String(init.body ?? "")).not.toContain(TOKEN);
		}
		expect(saved).toEqual([
			{
				version: "4.15.1",
				provider: "github",
				number: 7,
				url: "https://github.com/acme/apps/pull/7",
				branch: "alethia/addon-bump-ingress-nginx-4.15.1",
				state: "open",
				opened_by: "user-1",
				updated_at: "2026-11-12T00:00:00.000Z",
			},
		]);
		expect(JSON.stringify(r)).not.toContain(TOKEN);
		expect(logs.join("\n")).not.toContain(TOKEN);
	});

	it("no token ever appears in the answer or a log line, even when GitHub echoes it in an error body", async () => {
		for (const status of [401, 403, 404, 422, 500]) {
			const { fn } = fakeFetch({ status: (_url, method) => (method === "POST" ? status : null) });
			const { s, saved } = store("https://github.com/acme/apps");
			const r = await requestGitopsBumpFor(s, INPUT, fn, reader);
			expect(JSON.stringify(r)).not.toContain(TOKEN);
			expect(JSON.stringify(r)).not.toContain("Bad credentials");
			expect(r.status).toBe("refused");
			expect(saved).toEqual([]);
		}
		expect(logs.join("\n")).not.toContain(TOKEN);
	});

	it("a network failure is a refusal that names the operation, never the transport's text", async () => {
		const fetchImpl = vi.fn(async () => {
			throw new TypeError(`fetch failed for https://api.github.com?token=${TOKEN}`);
		});
		const r = await requestGitopsBumpFor(store("https://github.com/acme/apps").s, INPUT, fetchImpl, reader);
		expect(r).toMatchObject({ status: "refused", reason: "github-error" });
		expect(JSON.stringify(r)).not.toContain(TOKEN);
	});

	it("maps 401 to reconnect and 403 to permission", async () => {
		const statuses: [number, string][] = [
			[401, "token-rejected"],
			[403, "no-permission"],
		];
		for (const [status, reason] of statuses) {
			const { fn } = fakeFetch({ status: () => status });
			const r = await requestGitopsBumpFor(store("https://github.com/acme/apps").s, INPUT, fn, reader);
			expect(r).toMatchObject({ status: "refused", reason });
		}
	});
});

describe("requestGitopsBumpFor: what is asked for", () => {
	it("refuses, without a token, an add-on that is not installed, not GitOps, or has no apps repo", async () => {
		const reader = vi.fn(async () => TOKEN);
		const { fn } = fakeFetch();
		const cases: [ReturnType<typeof store>, string][] = [
			[store("https://github.com/acme/apps", null), "not-installed"],
			[store("https://github.com/acme/apps", { mode: "managed", source: "catalog", version: null, gitopsBump: null }), "not-gitops"],
			[store("https://github.com/acme/apps", { mode: "gitops", source: "byo", version: null, gitopsBump: null }), "not-catalog"],
			[store(null), "no-apps-repo"],
		];
		for (const [{ s }, reason] of cases) {
			expect(await requestGitopsBumpFor(s, INPUT, fn, reader)).toMatchObject({ status: "refused", reason });
		}
		expect(reader).not.toHaveBeenCalled();
		expect(fn).not.toHaveBeenCalled();
	});

	it("a user with no GitHub link is told to link it, and nothing is sent", async () => {
		const { fn } = fakeFetch();
		const r = await requestGitopsBumpFor(store("https://github.com/acme/apps").s, INPUT, fn, async () => null);
		expect(r).toMatchObject({ status: "refused", reason: "no-git-link" });
		expect(fn).not.toHaveBeenCalled();
	});
});

describe("requestGitopsBumpFor: only a person's own account opens the pull request", () => {
	it("a service token pinned to a shared org is refused, and no token is read or sent", async () => {
		const reader = vi.fn(async () => TOKEN);
		const { fn } = fakeFetch();
		const { s, saved } = store("https://github.com/acme/apps");
		const r = await requestGitopsBumpFor(
			s,
			{ ...INPUT, actor: { userId: "minter-1", orgId: "org-shared", credential: "service_token" } },
			fn,
			reader,
		);
		expect(r).toMatchObject({ status: "refused", reason: "not-a-person", file: "addons/ingress-nginx.yaml", version: "4.15.1" });
		expect(reader).not.toHaveBeenCalled();
		expect(fn).not.toHaveBeenCalled();
		expect(saved).toEqual([]);
	});

	it("a service token pinned to its minter's own personal workspace acts for that one person", async () => {
		const reader = vi.fn(async () => TOKEN);
		const { fn } = fakeFetch();
		const r = await requestGitopsBumpFor(
			store("https://github.com/acme/apps").s,
			{ ...INPUT, actor: { userId: "user-9", orgId: "user-9", credential: "service_token" } },
			fn,
			reader,
		);
		expect(r).toMatchObject({ status: "open", created: true });
		expect(reader).toHaveBeenCalledWith("user-9", "github");
	});
});

describe("requestGitopsBumpFor: the record and the pull request's text", () => {
	const reader = vi.fn(async () => TOKEN);
	const OPENED: GitopsBumpRecord = {
		version: "4.15.1",
		provider: "github",
		number: 7,
		url: "https://github.com/acme/apps/pull/7",
		branch: "alethia/addon-bump-ingress-nginx-4.15.1",
		state: "open",
		opened_by: "user-original",
		updated_at: "2026-11-01T00:00:00.000Z",
	};

	/** A GitHub that already has pull request #7 open on the bump branch. */
	function withOpenPull() {
		const pull = { number: 7, state: "open", html_url: OPENED.url, merged_at: null };
		return vi.fn(async (url: string) =>
			new URL(url).pathname.endsWith("/pulls") ? Response.json([pull]) : Response.json({}, { status: 404 }),
		);
	}

	it("finding a pull request someone else opened keeps the recorded opener", async () => {
		const { s, saved } = store("https://github.com/acme/apps", {
			mode: "gitops",
			source: "catalog",
			version: "4.15.1",
			gitopsBump: OPENED,
		});
		const r = await requestGitopsBumpFor(s, INPUT, withOpenPull(), reader);
		expect(r).toMatchObject({ status: "open", created: false, number: 7 });
		expect(saved.map((x) => x.opened_by)).toEqual(["user-original"]);
	});

	it("a found pull request with no record of it is recorded under the asker", async () => {
		const { s, saved } = store("https://github.com/acme/apps");
		await requestGitopsBumpFor(s, INPUT, withOpenPull(), reader);
		expect(saved.map((x) => x.opened_by)).toEqual(["user-1"]);
	});

	/** The body of the pull request the flow opened. */
	function openedBody(seen: { url: string; init: RequestInit }[]): string {
		const post = seen.find((c) => c.init.method === "POST" && new URL(c.url).pathname.endsWith("/pulls"));
		const parsed: unknown = JSON.parse(String(post?.init.body ?? "{}"));
		return typeof parsed === "object" && parsed !== null && "body" in parsed ? String(parsed.body) : "";
	}

	it("names the catalog's security release only when the target IS the catalog's version", async () => {
		const atCatalog = fakeFetch();
		await requestGitopsBumpFor(store("https://github.com/acme/apps").s, INPUT, atCatalog.fn, reader);
		expect(openedBody(atCatalog.seen)).toContain("**Security release.**");

		const atPin = fakeFetch();
		const pinned = store("https://github.com/acme/apps", { mode: "gitops", source: "catalog", version: "4.13.0", gitopsBump: null });
		const r = await requestGitopsBumpFor(pinned.s, INPUT, atPin.fn, reader);
		expect(r).toMatchObject({ status: "open", version: "4.13.0" });
		expect(openedBody(atPin.seen)).not.toContain("Security release");
	});
});

describe("githubClient / githubRepoFromUrl", () => {
	it("reads owner and repo from the URL forms the apps repo uses", () => {
		expect(githubRepoFromUrl("https://github.com/acme/apps.git")).toEqual({ owner: "acme", repo: "apps" });
		expect(githubRepoFromUrl("https://github.com/acme/apps")).toEqual({ owner: "acme", repo: "apps" });
		expect(githubRepoFromUrl("git@github.com:acme/apps.git")).toEqual({ owner: "acme", repo: "apps" });
		const bad = ["https://github.com/acme", "https://github.com/a/b/c", "https://github.com/-x/apps", "https://github.com/acme/..", "nope"];
		expect(bad.filter((u) => githubRepoFromUrl(u) !== null)).toEqual([]);
	});

	it("a failed call's error names the operation and status only", async () => {
		const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: TOKEN }), { status: 500 }));
		const gh = githubClient({ owner: "acme", repo: "apps" }, TOKEN, fetchImpl);
		await expect(gh.defaultBranch()).rejects.toThrow("GitHub read the repository returned HTTP 500");
		await expect(gh.defaultBranch()).rejects.toSatisfy((e: unknown) => !String(e).includes(TOKEN));
	});
});
