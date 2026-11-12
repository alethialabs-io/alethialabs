// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The bump pull request flow (#6549) against an in-memory GitHub: dedupe, the declined rule, the
// branch-reuse rule, the race, and what the pull request says.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { GithubCallError, type GithubClient, type GithubPull } from "@/lib/addons/gitops-bump/github";
import { bumpBranchName, bumpPullText, openGitopsBump, type BumpRequest } from "@/lib/addons/gitops-bump/open-bump";

const FIXTURES = resolve(__dirname, "../../../../../../packages/core/provisioner/testdata/addon_bump");
const SEEDED = new Uint8Array(readFileSync(join(FIXTURES, "plain.yaml")));
const BUMPED = new Uint8Array(readFileSync(join(FIXTURES, "plain.expected.yaml")));
const PATH = "addons/ingress-nginx.yaml";

const REQ: BumpRequest = { addonId: "ingress-nginx", chart: "ingress-nginx", version: "4.15.1", again: false, security: null };

/** A blob sha, content-addressed as GitHub's is: the same bytes on two branches are the same blob. */
const blob = (bytes: Uint8Array) => createHash("sha1").update(bytes).digest("hex");

/**
 * One repo in memory: branches map to files, pull requests are kept with their head, and `commits`
 * holds, per branch, the files each of its own commits (the ones `main` does not have) changed.
 */
function fakeGithub(opts: { file?: Uint8Array | null } = {}) {
	const branches = new Map<string, Map<string, Uint8Array>>([["main", new Map()]]);
	const commits = new Map<string, string[][]>();
	/** Runs once, just before the next commit: stands in for a concurrent click committing first. */
	let beforeNextWrite: (() => void) | null = null;
	const main = branches.get("main");
	if (main && opts.file !== null) main.set(PATH, opts.file ?? SEEDED);
	const pulls: (GithubPull & { head: string; title: string; body: string })[] = [];
	const calls: string[] = [];
	let duplicateOnce = false;
	const client: GithubClient = {
		async defaultBranch() {
			calls.push("defaultBranch");
			return "main";
		},
		async branchHead(branch) {
			calls.push(`branchHead:${branch}`);
			return branches.has(branch) ? `sha-${branch}` : null;
		},
		async readFile(path, branch) {
			calls.push(`readFile:${branch}`);
			const f = branches.get(branch)?.get(path);
			return f ? { bytes: f, sha: blob(f) } : null;
		},
		async pullsFrom(branch) {
			calls.push("pullsFrom");
			return pulls.filter((p) => p.head === branch).map(({ number, url, state, merged }) => ({ number, url, state, merged }));
		},
		async createBranch(branch) {
			calls.push("createBranch");
			if (branches.has(branch)) return false;
			branches.set(branch, new Map(branches.get("main")));
			return true;
		},
		async writeFile(path, branch, bytes, sha) {
			calls.push("writeFile");
			const hook = beforeNextWrite;
			beforeNextWrite = null;
			hook?.();
			// GitHub refuses a commit whose blob sha is no longer the file's: the file moved.
			const current = branches.get(branch)?.get(path);
			if (!current || sha !== blob(current)) return false;
			branches.get(branch)?.set(path, bytes);
			commits.set(branch, [...(commits.get(branch) ?? []), [path]]);
			return true;
		},
		async compare(_base, head) {
			calls.push("compare");
			const own = commits.get(head) ?? [];
			return { aheadBy: own.length, files: [...new Set(own.flat())] };
		},
		async openPull(input) {
			calls.push("openPull");
			if (duplicateOnce) {
				duplicateOnce = false;
				const number = pulls.length + 1;
				pulls.push({ number, url: `https://github.com/acme/apps/pull/${number}`, state: "open", merged: false, ...input });
				return null;
			}
			if (pulls.some((p) => p.head === input.head && p.state === "open")) return null;
			const number = pulls.length + 1;
			const url = `https://github.com/acme/apps/pull/${number}`;
			pulls.push({ number, url, state: "open", merged: false, ...input });
			return { number, url, state: "open", merged: false };
		},
	};
	return {
		client,
		branches,
		commits,
		pulls,
		calls,
		beforeNextWrite: (fn: () => void) => {
			beforeNextWrite = fn;
		},
		raceNextOpen: () => {
			duplicateOnce = true;
		},
	};
}

const writes = (calls: string[]) => calls.filter((c) => c === "createBranch" || c === "writeFile" || c === "openPull");

describe("openGitopsBump (#6549)", () => {
	it("opens a pull request on the deterministic branch, with the edited file", async () => {
		const gh = fakeGithub();
		const out = await openGitopsBump(gh.client, REQ);
		expect(out.kind).toBe("opened");
		const branch = bumpBranchName("ingress-nginx", "4.15.1");
		expect(branch).toBe("alethia/addon-bump-ingress-nginx-4.15.1");
		expect(Buffer.from(gh.branches.get(branch)?.get(PATH) ?? new Uint8Array()).equals(Buffer.from(BUMPED))).toBe(true);
		expect(gh.pulls).toHaveLength(1);
		expect(gh.pulls[0]?.head).toBe(branch);
		expect(gh.pulls[0]?.title).toBe("chore(addons): bump ingress-nginx chart to 4.15.1");
	});

	it("dedupe: a second request returns the SAME pull request and writes nothing", async () => {
		const gh = fakeGithub();
		const first = await openGitopsBump(gh.client, REQ);
		gh.calls.length = 0;
		const second = await openGitopsBump(gh.client, REQ);
		expect(second.kind).toBe("existing");
		if (first.kind !== "opened" || second.kind !== "existing") throw new Error("unreachable");
		expect(second.pull.number).toBe(first.pull.number);
		expect(writes(gh.calls)).toEqual([]);
		expect(gh.pulls).toHaveLength(1);
	});

	it("a declined pull request is reported and NEVER reopened without the explicit ask", async () => {
		const gh = fakeGithub();
		await openGitopsBump(gh.client, REQ);
		const p = gh.pulls[0];
		if (!p) throw new Error("unreachable");
		p.state = "closed"; // closed without merging
		for (let i = 0; i < 3; i++) {
			gh.calls.length = 0;
			const out = await openGitopsBump(gh.client, REQ);
			expect(out.kind).toBe("declined");
			expect(writes(gh.calls)).toEqual([]);
		}
		expect(gh.pulls).toHaveLength(1);
	});

	it("again: the explicit ask opens a new pull request, reusing the branch that holds the edit", async () => {
		const gh = fakeGithub();
		await openGitopsBump(gh.client, REQ);
		const p = gh.pulls[0];
		if (!p) throw new Error("unreachable");
		p.state = "closed";
		gh.calls.length = 0;
		const out = await openGitopsBump(gh.client, { ...REQ, again: true });
		expect(out.kind).toBe("opened");
		expect(gh.calls).not.toContain("writeFile"); // the branch already holds exactly this edit
		expect(gh.pulls).toHaveLength(2);
	});

	it("a merged pull request is reported and nothing is written", async () => {
		const gh = fakeGithub();
		await openGitopsBump(gh.client, REQ);
		const p = gh.pulls[0];
		if (!p) throw new Error("unreachable");
		p.state = "closed";
		p.merged = true;
		gh.calls.length = 0;
		expect((await openGitopsBump(gh.client, { ...REQ, again: true })).kind).toBe("merged");
		expect(writes(gh.calls)).toEqual([]);
	});

	it("a branch left by a failed attempt (still the default branch's file) gets the commit", async () => {
		const gh = fakeGithub();
		const branch = bumpBranchName("ingress-nginx", "4.15.1");
		gh.branches.set(branch, new Map([[PATH, SEEDED]]));
		const out = await openGitopsBump(gh.client, REQ);
		expect(out.kind).toBe("opened");
		expect(Buffer.from(gh.branches.get(branch)?.get(PATH) ?? new Uint8Array()).equals(Buffer.from(BUMPED))).toBe(true);
	});

	it("a branch someone else pushed to is refused, and no pull request is opened", async () => {
		const gh = fakeGithub();
		const branch = bumpBranchName("ingress-nginx", "4.15.1");
		gh.branches.set(branch, new Map([[PATH, new TextEncoder().encode("kind: Application\n# theirs\n")]]));
		expect((await openGitopsBump(gh.client, REQ)).kind).toBe("branch-diverged");
		expect(gh.pulls).toHaveLength(0);
	});

	it("a branch carrying the edit AND a change to another file is refused, in one commit or two", async () => {
		const branch = bumpBranchName("ingress-nginx", "4.15.1");
		const shapes: string[][][] = [[[PATH, "README.md"]], [[PATH], ["README.md"]], [["README.md"]]];
		for (const shape of shapes) {
			const gh = fakeGithub();
			// The add-on's file on the branch is EXACTLY the edit; only the compare can tell.
			gh.branches.set(branch, new Map([[PATH, BUMPED], ["README.md", new TextEncoder().encode("theirs\n")]]));
			gh.commits.set(branch, shape);
			expect(await openGitopsBump(gh.client, REQ)).toEqual({ kind: "branch-diverged", branch });
			expect(writes(gh.calls)).toEqual(["createBranch"]);
			expect(gh.pulls).toHaveLength(0);
		}
	});

	it("a branch holding only this flow's own one-file commit is reused as it is", async () => {
		const gh = fakeGithub();
		const branch = bumpBranchName("ingress-nginx", "4.15.1");
		gh.branches.set(branch, new Map([[PATH, BUMPED]]));
		gh.commits.set(branch, [[PATH]]);
		expect((await openGitopsBump(gh.client, REQ)).kind).toBe("opened");
		expect(gh.calls).not.toContain("writeFile");
	});

	it("a concurrent click that committed first: the conflict is a reuse, not a failed commit", async () => {
		const gh = fakeGithub();
		const branch = bumpBranchName("ingress-nginx", "4.15.1");
		// The other click's commit lands between this call's branch creation and its commit.
		gh.beforeNextWrite(() => {
			gh.branches.get(branch)?.set(PATH, BUMPED);
			gh.commits.set(branch, [[PATH]]);
		});
		const out = await openGitopsBump(gh.client, REQ);
		expect(out.kind).toBe("opened");
		expect(gh.pulls).toHaveLength(1);
	});

	it("a race with another click returns the pull request the other click opened", async () => {
		const gh = fakeGithub();
		gh.raceNextOpen();
		const out = await openGitopsBump(gh.client, REQ);
		expect(out.kind).toBe("existing");
		expect(gh.pulls).toHaveLength(1);
	});

	it("refuses a file it cannot be sure of, and a missing file, without writing", async () => {
		const gh = fakeGithub({ file: new Uint8Array(readFileSync(join(FIXTURES, "range.yaml"))) });
		expect(await openGitopsBump(gh.client, REQ)).toEqual({ kind: "not-bumpable", refusal: "revision-not-semver" });
		expect(writes(gh.calls)).toEqual([]);
		const none = fakeGithub({ file: null });
		expect(await openGitopsBump(none.client, REQ)).toEqual({ kind: "no-file" });
	});

	it("refuses an add-on id or version that cannot name a branch, before any call", async () => {
		for (const bad of [
			{ ...REQ, addonId: "../x" },
			{ ...REQ, addonId: "a b" },
			{ ...REQ, addonId: "x;rm" },
			{ ...REQ, addonId: "Ingress" },
			{ ...REQ, version: "4.15.1~1" },
			{ ...REQ, version: "4.15.1/../../main" },
			{ ...REQ, chart: "" },
		]) {
			const gh = fakeGithub();
			expect(await openGitopsBump(gh.client, bad)).toEqual({ kind: "invalid-input" });
			expect(gh.calls).toEqual([]);
		}
	});

	it("a GitHub failure is reported by operation and status", async () => {
		const gh = fakeGithub();
		gh.client.createBranch = async () => {
			throw new GithubCallError("create a branch", 403);
		};
		expect(await openGitopsBump(gh.client, REQ)).toEqual({ kind: "github-error", operation: "create a branch", status: 403 });
		expect(gh.pulls).toHaveLength(0);
	});
});

describe("bumpPullText", () => {
	it("names the add-on, the file, the field and both versions, and copies nothing from the file", () => {
		const t = bumpPullText(
			{ ...REQ, security: { summary: "Fixes CVE-2025-1974.", advisoryUrl: "https://example.com/advisory" } },
			"4.11.2",
		);
		for (const part of ["ingress-nginx", "addons/ingress-nginx.yaml", "spec.source.targetRevision", "4.11.2", "4.15.1", "not migrated"]) {
			expect(t.body).toContain(part);
		}
		expect(t.body).toContain("Fixes CVE-2025-1974.");
		// The seeded file carries Helm values; none of them, nor its repo URL, reaches the body.
		expect(t.body).not.toContain("replicaCount");
		expect(t.body).not.toContain("kubernetes.github.io");
	});
});
