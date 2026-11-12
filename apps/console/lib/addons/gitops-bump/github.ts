// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The GitHub REST calls the bump pull request needs (#6549), and nothing else. Every request goes
// to api.github.com with the token in the Authorization header. A token is never put in a URL,
// never logged, and never copied into an error: a failed call is reported by its HTTP status only,
// because a provider's error body is not ours to forward.
//
// Permissions, for a reader deciding what a token must hold: reading a file and a ref needs
// Contents: read; creating a branch and committing a file needs Contents: write; listing and
// opening pull requests needs Pull requests: read and write (fine-grained token names). The
// console's GitHub OAuth app asks for `repo`, which covers all of them.

import { resolveGitProvider } from "@/lib/git/provider-host";

const API = "https://api.github.com";

/** How long one GitHub call may take before it is abandoned. */
const CALL_TIMEOUT_MS = 15_000;

/** The GitHub repository a pull request is opened against. */
export interface GithubRepoRef {
	owner: string;
	repo: string;
}

// GitHub's owner and repository name alphabets. Anything else is not a GitHub repository, and both
// are interpolated into an API path, so they are refused rather than escaped.
const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const GITHUB_REPO = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * The owner and repository of a GitHub repo URL, or null. It reads the PATH only: whether the URL is
 * a GitHub one at all is `resolveGitProvider`'s decision (lib/git/provider-host.ts), which the
 * caller makes first. Accepts `https://github.com/owner/repo(.git)` and `git@github.com:owner/repo(.git)`.
 */
export function githubRepoFromUrl(repoUrl: string): GithubRepoRef | null {
	const s = repoUrl.trim();
	const scp = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:(.+)$/.exec(s);
	let path: string;
	if (scp?.[1] && !s.includes("://")) {
		path = scp[1];
	} else {
		try {
			path = new URL(s).pathname;
		} catch {
			return null;
		}
	}
	const parts = path.split("/").filter((p) => p !== "");
	if (parts.length !== 2) return null;
	const owner = parts[0] ?? "";
	const repo = (parts[1] ?? "").replace(/\.git$/, "");
	if (!GITHUB_OWNER.test(owner) || !GITHUB_REPO.test(repo) || repo === "." || repo === "..") return null;
	return { owner, repo };
}

/**
 * The apps repo as `owner/repo` when it is a GitHub repository, else null: what the card shows as
 * where the pull request will be opened. The same two decisions the bump makes, in the same order
 * (`resolveGitProvider`, then `githubRepoFromUrl`), so the card cannot name a repo the bump would not use.
 */
export function githubRepoName(repoUrl: string | null | undefined): string | null {
	if (!repoUrl) return null;
	const provider = resolveGitProvider(repoUrl);
	if (!provider.ok || provider.provider !== "github") return null;
	const ref = githubRepoFromUrl(repoUrl);
	return ref ? `${ref.owner}/${ref.repo}` : null;
}

/** A failed GitHub call: the operation and the HTTP status, never the body or the token. */
export class GithubCallError extends Error {
	/** Builds the error for one failed operation. */
	constructor(
		readonly operation: string,
		readonly status: number,
	) {
		super(`GitHub ${operation} returned HTTP ${status}`);
		this.name = "GithubCallError";
	}
}

/** One pull request, as the bump flow reads it. */
export interface GithubPull {
	number: number;
	url: string;
	state: "open" | "closed";
	merged: boolean;
}

/** The fetch the client calls; a parameter so tests can stand in for GitHub. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Narrows an unknown JSON value to a plain object. */
function obj(v: unknown): Record<string, unknown> | null {
	return typeof v === "object" && v !== null && !Array.isArray(v) ? Object.fromEntries(Object.entries(v)) : null;
}

/** Reads a string field, or "". */
function str(o: Record<string, unknown> | null, k: string): string {
	const v = o?.[k];
	return typeof v === "string" ? v : "";
}

/** Narrows a pull-request JSON object, or null when it is not one. */
function toPull(v: unknown): GithubPull | null {
	const o = obj(v);
	const number = o?.number;
	const state = o?.state;
	const url = str(o, "html_url");
	if (typeof number !== "number" || (state !== "open" && state !== "closed") || !url.startsWith("https://github.com/")) {
		return null;
	}
	return { number, url, state, merged: typeof o?.merged_at === "string" };
}

/** Encodes a repo path for a URL, segment by segment, so `/` stays a separator. */
function encPath(p: string): string {
	return p.split("/").map(encodeURIComponent).join("/");
}

/** Base64 of raw bytes. */
function toBase64(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64");
}

/** The GitHub calls for one repository, authorised by one user's token. */
export function githubClient(ref: GithubRepoRef, token: string, fetchImpl: FetchLike) {
	const base = `${API}/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`;

	/**
	 * Sends one request and parses its JSON. A status in `allow` is returned as `{ refused: status }`
	 * instead of throwing, so a caller that must tell those statuses apart still can.
	 */
	async function request(
		operation: string,
		path: string,
		init: RequestInit = {},
		allow: number[] = [],
	): Promise<{ refused: number } | { body: unknown }> {
		let res: Response;
		try {
			res = await fetchImpl(`${base}${path}`, {
				...init,
				headers: {
					Authorization: `Bearer ${token}`,
					Accept: "application/vnd.github+json",
					"X-GitHub-Api-Version": "2022-11-28",
					...(init.body ? { "Content-Type": "application/json" } : {}),
				},
				// A redirect would carry the Authorization header to wherever it points; refuse it.
				redirect: "error",
				// Bounded, so a GitHub that stalls cannot hold the user's request open indefinitely.
				signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
			});
		} catch {
			// A network failure, a timeout or a refused redirect. Its text is not forwarded.
			throw new GithubCallError(operation, 0);
		}
		if (allow.includes(res.status)) return { refused: res.status };
		if (!res.ok) throw new GithubCallError(operation, res.status);
		try {
			return { body: await res.json() };
		} catch {
			throw new GithubCallError(operation, res.status);
		}
	}

	/** `request`, with a status in `allow` returned as null: for callers that need only "refused". */
	async function call(operation: string, path: string, init: RequestInit = {}, allow: number[] = []): Promise<unknown> {
		const res = await request(operation, path, init, allow);
		return "body" in res ? res.body : null;
	}

	return {
		/** The repository's default branch. */
		async defaultBranch(): Promise<string> {
			const branch = str(obj(await call("read the repository", "")), "default_branch");
			if (!branch) throw new GithubCallError("read the repository", 0);
			return branch;
		},
		/** The commit a branch points at, or null when the branch does not exist. */
		async branchHead(branch: string): Promise<string | null> {
			const ref = obj(await call("read a branch", `/git/ref/heads/${encPath(branch)}`, {}, [404]));
			if (!ref) return null;
			const sha = str(obj(ref.object), "sha");
			if (!sha) throw new GithubCallError("read a branch", 0);
			return sha;
		},
		/** A file's bytes and blob sha on a branch, or null when the file does not exist there. */
		async readFile(path: string, branch: string): Promise<{ bytes: Uint8Array; sha: string } | null> {
			const o = obj(await call("read a file", `/contents/${encPath(path)}?ref=${encodeURIComponent(branch)}`, {}, [404]));
			if (!o) return null;
			const content = str(o, "content");
			const sha = str(o, "sha");
			if (str(o, "encoding") !== "base64" || !sha) throw new GithubCallError("read a file", 0);
			return { bytes: new Uint8Array(Buffer.from(content, "base64")), sha };
		},
		/** Every pull request, open or closed, whose head is `branch` in this repository. */
		async pullsFrom(branch: string): Promise<GithubPull[]> {
			const head = encodeURIComponent(`${ref.owner}:${branch}`);
			const list = await call("list pull requests", `/pulls?head=${head}&state=all&per_page=30`);
			return Array.isArray(list) ? list.map(toPull).filter((p): p is GithubPull => p !== null) : [];
		},
		/** Creates `branch` at `sha`; false when it already exists. */
		async createBranch(branch: string, sha: string): Promise<boolean> {
			const made = await call(
				"create a branch",
				"/git/refs",
				{ method: "POST", body: JSON.stringify({ ref: `refs/heads/${branch}`, sha }) },
				[422],
			);
			return made !== null;
		},
		/**
		 * Commits `bytes` as `path` on `branch`, replacing the blob `sha`. A 409 or 422 is returned as
		 * `{ ok: false, status }` rather than thrown, because one cause of either is a concurrent click
		 * that committed first, and the caller tells that apart by re-reading the branch.
		 *
		 * What the statuses mean, per GitHub's REST reference for "Create or update file contents"
		 * (https://docs.github.com/en/rest/repos/contents#create-or-update-file-contents): 409 is
		 * "Conflict", and 422 is "Validation failed, or the endpoint has been spammed." The reference
		 * says no more than that: it does not name which of the two a stale `sha` produces, and a
		 * repository rule or push protection can refuse a commit too. So neither status on its own
		 * proves a race; only the re-read branch does.
		 */
		async writeFile(
			path: string,
			branch: string,
			bytes: Uint8Array,
			sha: string,
			message: string,
		): Promise<{ ok: true } | { ok: false; status: number }> {
			const res = await request(
				"commit the file",
				`/contents/${encPath(path)}`,
				{ method: "PUT", body: JSON.stringify({ message, content: toBase64(bytes), sha, branch }) },
				[409, 422],
			);
			return "refused" in res ? { ok: false, status: res.refused } : { ok: true };
		},
		/**
		 * What `head` holds that `base` does not: how many commits it is ahead, and every file those
		 * commits change, or null for the files when GitHub did not list them (a very large diff).
		 */
		async compare(base: string, head: string): Promise<{ aheadBy: number; files: string[] | null }> {
			const o = obj(await call("compare the branch", `/compare/${encPath(`${base}...${head}`)}`));
			const ahead = o?.ahead_by;
			if (typeof ahead !== "number") throw new GithubCallError("compare the branch", 0);
			const list = o?.files;
			const files = Array.isArray(list) ? list.map((f) => str(obj(f), "filename")) : null;
			return { aheadBy: ahead, files: files && files.every((f) => f !== "") ? files : null };
		},
		/** Opens a pull request; null when GitHub says one already exists for that head. */
		async openPull(input: { title: string; body: string; head: string; base: string }): Promise<GithubPull | null> {
			const made = await call("open the pull request", "/pulls", { method: "POST", body: JSON.stringify(input) }, [422]);
			return made === null ? null : toPull(made);
		},
	};
}

/** The client's type, for the flow that drives it. */
export type GithubClient = ReturnType<typeof githubClient>;
