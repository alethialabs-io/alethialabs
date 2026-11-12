// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The real GitHub client (#6549) against a fake `fetch`: how it reads a compare and how it reports a
// refused commit. The flow tests fake the whole client, so this is the only place its parsing runs.

import { describe, expect, it } from "vitest";
import { GithubCallError, githubClient, type FetchLike } from "@/lib/addons/gitops-bump/github";

const REF = { owner: "acme", repo: "apps" };

/** A fetch that answers every call with one status and JSON body, and records what it was sent. */
function fakeFetch(status: number, body: unknown) {
	const sent: { url: string; init: RequestInit }[] = [];
	const fetchImpl: FetchLike = async (url, init) => {
		sent.push({ url, init });
		return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
	};
	return { fetchImpl, sent };
}

describe("githubClient.compare", () => {
	it("reads the commits ahead and every changed file", async () => {
		const f = fakeFetch(200, {
			ahead_by: 1,
			behind_by: 0,
			files: [{ filename: "addons/ingress-nginx.yaml" }, { filename: "README.md" }],
		});
		const gh = githubClient(REF, "tok", f.fetchImpl);
		expect(await gh.compare("main", "alethia/addon-bump-ingress-nginx-4.15.1")).toEqual({
			aheadBy: 1,
			files: ["addons/ingress-nginx.yaml", "README.md"],
		});
		expect(f.sent[0]?.url).toBe(
			"https://api.github.com/repos/acme/apps/compare/main...alethia/addon-bump-ingress-nginx-4.15.1",
		);
	});

	it("reports the files as unknown (null) when GitHub does not list them", async () => {
		const gh = githubClient(REF, "tok", fakeFetch(200, { ahead_by: 3 }).fetchImpl);
		expect(await gh.compare("main", "b")).toEqual({ aheadBy: 3, files: null });
	});

	it("reads a branch with no commits of its own as 0 ahead", async () => {
		const gh = githubClient(REF, "tok", fakeFetch(200, { ahead_by: 0, files: [] }).fetchImpl);
		expect(await gh.compare("main", "b")).toEqual({ aheadBy: 0, files: [] });
	});

	it("refuses a compare with no commit count rather than guessing one", async () => {
		const gh = githubClient(REF, "tok", fakeFetch(200, { files: [] }).fetchImpl);
		await expect(gh.compare("main", "b")).rejects.toBeInstanceOf(GithubCallError);
	});
});

describe("githubClient.writeFile", () => {
	const bytes = new TextEncoder().encode("kind: Application\n");

	it("commits with a PUT carrying the replaced blob sha and the branch", async () => {
		const f = fakeFetch(200, { content: {}, commit: {} });
		const gh = githubClient(REF, "tok", f.fetchImpl);
		expect(await gh.writeFile("addons/x.yaml", "b", bytes, "abc", "msg")).toEqual({ ok: true });
		expect(f.sent[0]?.init.method).toBe("PUT");
		expect(JSON.parse(String(f.sent[0]?.init.body))).toMatchObject({ sha: "abc", branch: "b", message: "msg" });
	});

	it("returns a 409 or a 422 as a refusal with its status, not a throw", async () => {
		for (const status of [409, 422]) {
			const gh = githubClient(REF, "tok", fakeFetch(status, { message: "x" }).fetchImpl);
			expect(await gh.writeFile("addons/x.yaml", "b", bytes, "abc", "msg")).toEqual({ ok: false, status });
		}
	});

	it("throws any other failure, by operation and status", async () => {
		const gh = githubClient(REF, "tok", fakeFetch(403, { message: "x" }).fetchImpl);
		await expect(gh.writeFile("addons/x.yaml", "b", bytes, "abc", "msg")).rejects.toMatchObject({
			operation: "commit the file",
			status: 403,
		});
	});
});
