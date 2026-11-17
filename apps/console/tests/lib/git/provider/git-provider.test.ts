// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// The provider seam (lib/git/provider/git-provider.ts) is mostly types, so what can be pinned at run
// time is small and stated here:
//
//   1. THE CLOSED LISTS. The failure reasons, the check conclusions and the webhook refusals are
//      exactly these. A lane that needs another one changes the contract and this test together.
//   2. THE RESULT HELPERS. `gitOk`, `gitFailure` and `isRetryableGitFailure` behave as documented.
//   3. THE INTERFACE IS IMPLEMENTABLE WITHOUT A NETWORK. The in-memory adapter below is typed as
//      `GitProviderAdapter`; if a method's shape stops being satisfiable the type-check fails here,
//      before any real adapter is written against it.
//
// Boundary, stated: the adapter below is a stand-in written for this file. Passing here says the
// contract is coherent, not that any real git host behaves this way.

import { describe, expect, it } from "vitest";
import {
	GIT_CHECK_CONCLUSIONS,
	GIT_PROVIDER_FAILURE_REASONS,
	type GitFile,
	type GitProviderAdapter,
	type GitRepoRef,
	gitFailure,
	gitOk,
	isRetryableGitFailure,
	WEBHOOK_REFUSAL_REASONS,
} from "@/lib/git/provider/git-provider";

const REPO: GitRepoRef = {
	installationId: "1001",
	repositoryId: "2002",
	owner: "acme",
	name: "shop",
};

/** A header bag that reads names case-insensitively, as a Fetch `Headers` does. */
function headers(values: Record<string, string>) {
	const lower = new Map(Object.entries(values).map(([k, v]) => [k.toLowerCase(), v]));
	return { get: (name: string) => lower.get(name.toLowerCase()) ?? null };
}

/** An adapter that keeps one branch's files in memory and never leaves the process. */
function memoryAdapter(files: Map<string, GitFile>): GitProviderAdapter {
	let comments = 0;
	return {
		provider: "github",
		async readFile({ path }) {
			return gitOk(files.get(path) ?? null);
		},
		async openChangeRequest({ headBranch, files: writes }) {
			for (const write of writes) {
				const current = files.get(write.path) ?? null;
				if (write.expectedBlobSha !== undefined && write.expectedBlobSha !== (current?.blobSha ?? null)) {
					return gitFailure("conflict", `${write.path} changed since it was read`);
				}
			}
			return gitOk({ number: 7, url: "https://git.example/acme/shop/pull/7", headBranch, headSha: "abc", created: true });
		},
		async upsertComment({ commentId }) {
			if (commentId !== undefined) return gitOk({ commentId, created: false });
			comments += 1;
			return gitOk({ commentId: `c${comments}`, created: true });
		},
		async setCheck({ checkId }) {
			return gitOk({ checkId: checkId ?? "check-1" });
		},
		async verifyWebhook({ headers: h }) {
			if (h.get("x-signature") === null) return { ok: false, reason: "missing_signature" };
			const deliveryId = h.get("x-delivery");
			if (deliveryId === null) return { ok: false, reason: "missing_delivery_id" };
			return {
				ok: true,
				delivery: { provider: "github", deliveryId, event: "push", action: null, installationId: "1001", payload: {} },
			};
		},
		async mintRepoToken() {
			return gitFailure("rate_limited", "slow down", 30);
		},
		async getBranchProtection() {
			return gitOk({ state: "unknown" });
		},
	};
}

describe("the closed lists", () => {
	it("names exactly these failure reasons", () => {
		expect([...GIT_PROVIDER_FAILURE_REASONS]).toEqual([
			"not_found",
			"permission_denied",
			"conflict",
			"rate_limited",
			"unavailable",
			"unsupported",
		]);
	});

	it("names exactly these check conclusions", () => {
		expect([...GIT_CHECK_CONCLUSIONS]).toEqual(["success", "failure", "neutral", "action_required"]);
	});

	it("names exactly these webhook refusals", () => {
		expect([...WEBHOOK_REFUSAL_REASONS]).toEqual([
			"missing_signature",
			"bad_signature",
			"missing_delivery_id",
			"missing_event",
			"malformed_payload",
		]);
	});
});

describe("gitOk and gitFailure", () => {
	it("wraps a value, including null", () => {
		expect(gitOk(3)).toEqual({ ok: true, value: 3 });
		expect(gitOk(null)).toEqual({ ok: true, value: null });
	});

	it("builds a failure with no wait unless one is given", () => {
		expect(gitFailure("not_found", "no such repository")).toEqual({
			ok: false,
			reason: "not_found",
			message: "no such repository",
		});
	});

	it("keeps a wait that is a positive whole number of seconds", () => {
		expect(gitFailure("rate_limited", "slow down", 30)).toEqual({
			ok: false,
			reason: "rate_limited",
			message: "slow down",
			retryAfterSeconds: 30,
		});
	});

	it.each([0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("drops a wait of %s", (wait) => {
		expect(gitFailure("rate_limited", "slow down", wait)).not.toHaveProperty("retryAfterSeconds");
	});
});

describe("isRetryableGitFailure", () => {
	it.each([...GIT_PROVIDER_FAILURE_REASONS])("classifies %s", (reason) => {
		const expected = reason === "rate_limited" || reason === "unavailable";
		expect(isRetryableGitFailure(gitFailure(reason, "x"))).toBe(expected);
	});
});

describe("an adapter with no network behind it", () => {
	const file: GitFile = { path: "alethia.yaml", ref: "main", blobSha: "b1", content: "project: shop\n" };

	it("answers a missing file with null, not with a failure", async () => {
		const adapter = memoryAdapter(new Map([[file.path, file]]));
		expect(await adapter.readFile({ repo: REPO, path: "alethia.yaml", ref: "main" })).toEqual(gitOk(file));
		expect(await adapter.readFile({ repo: REPO, path: "other.yaml", ref: "main" })).toEqual(gitOk(null));
	});

	it("refuses a write rendered from a file that has since changed, and accepts a current one", async () => {
		const adapter = memoryAdapter(new Map([[file.path, file]]));
		const request = {
			repo: REPO,
			baseBranch: "main",
			headBranch: "alethia/change-1",
			title: "Add a cache",
			body: "",
			commitMessage: "Add a cache",
		};
		const stale = await adapter.openChangeRequest({
			...request,
			files: [{ path: file.path, content: "project: shop2\n", expectedBlobSha: "b0" }],
		});
		expect(stale).toMatchObject({ ok: false, reason: "conflict" });

		const current = await adapter.openChangeRequest({
			...request,
			files: [
				{ path: file.path, content: "project: shop2\n", expectedBlobSha: "b1" },
				{ path: "new.yaml", content: "a: 1\n", expectedBlobSha: null },
			],
		});
		expect(current).toMatchObject({ ok: true, value: { number: 7, created: true } });
	});

	it("keeps one comment per key across calls", async () => {
		const adapter = memoryAdapter(new Map());
		const first = await adapter.upsertComment({ repo: REPO, changeRequestNumber: 7, key: "plan", body: "one" });
		expect(first).toEqual(gitOk({ commentId: "c1", created: true }));
		const second = await adapter.upsertComment({
			repo: REPO,
			changeRequestNumber: 7,
			key: "plan",
			body: "two",
			commentId: "c1",
		});
		expect(second).toEqual(gitOk({ commentId: "c1", created: false }));
	});

	it("moves a check forward by the id the first call returned", async () => {
		const adapter = memoryAdapter(new Map());
		const check = { repo: REPO, headSha: "abc", name: "Alethia plan", title: "Planning", summary: "" };
		const created = await adapter.setCheck({ ...check, state: { status: "in_progress" } });
		expect(created).toEqual(gitOk({ checkId: "check-1" }));
		const done = await adapter.setCheck({
			...check,
			checkId: "check-1",
			state: { status: "completed", conclusion: "neutral" },
		});
		expect(done).toEqual(gitOk({ checkId: "check-1" }));
	});

	it("refuses a delivery before reading it, and hands back the installation from a verified one", async () => {
		const adapter = memoryAdapter(new Map());
		const rawBody = new TextEncoder().encode("{}");
		expect(await adapter.verifyWebhook({ rawBody, headers: headers({}) })).toEqual({
			ok: false,
			reason: "missing_signature",
		});
		expect(await adapter.verifyWebhook({ rawBody, headers: headers({ "X-Signature": "s" }) })).toEqual({
			ok: false,
			reason: "missing_delivery_id",
		});
		const verified = await adapter.verifyWebhook({
			rawBody,
			headers: headers({ "X-Signature": "s", "X-Delivery": "d-1" }),
		});
		expect(verified).toMatchObject({ ok: true, delivery: { deliveryId: "d-1", installationId: "1001" } });
	});

	it("reports a rate limit as a retryable failure with its wait", async () => {
		const adapter = memoryAdapter(new Map());
		const minted = await adapter.mintRepoToken({ repo: REPO, contents: "read" });
		expect(minted).toEqual(gitFailure("rate_limited", "slow down", 30));
		expect(minted.ok === false && isRetryableGitFailure(minted)).toBe(true);
	});

	it("can answer that it does not know whether a branch is protected", async () => {
		const adapter = memoryAdapter(new Map());
		expect(await adapter.getBranchProtection({ repo: REPO, branch: "main" })).toEqual(gitOk({ state: "unknown" }));
	});
});
