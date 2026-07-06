// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Mocked-boundary tests for the git-repositories server actions. We stub ONLY the boundaries this
// action actually touches — the owner/session helper (@/lib/auth/owner.getOwner), the linked-
// provider + token helpers (@/app/server/actions/identities, imported as ../identities), the
// GitLab base-URL config (@/lib/config/auth.getGitlabBaseUrl) and the global `fetch` git-provider
// API. The pure provider->Repository mappers and the URL/path construction stay REAL. We exercise
// the real exported actions and assert: the auth/token rejection branches, the per-provider response
// mapping (github/gitlab/bitbucket), the path-injection (SSRF) hardening that encodeURIComponent's
// the user-supplied Bitbucket workspace/name BEFORE any fetch, the auth-error-code mapping, and the
// outer error handling / return shapes.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/owner", () => ({ getOwner: vi.fn() }));
vi.mock("@/lib/config/auth", () => ({ getGitlabBaseUrl: vi.fn() }));
vi.mock("@/app/server/actions/identities", () => ({
	getLinkedProviders: vi.fn(),
	getValidProviderToken: vi.fn(),
}));

import {
	createRepository,
	fetchAllRepositories,
	fetchRepositoriesByProvider,
} from "@/app/server/actions/git/repositories";
import { getOwner } from "@/lib/auth/owner";
import { getGitlabBaseUrl } from "@/lib/config/auth";
import {
	getLinkedProviders,
	getValidProviderToken,
} from "@/app/server/actions/identities";

const fetchMock = vi.fn();

/** A Response-like stub exposing both json() and text() over the same body. */
function res(
	body: unknown,
	{ ok = true, status = 200 }: { ok?: boolean; status?: number } = {},
) {
	const text = typeof body === "string" ? body : JSON.stringify(body);
	return {
		ok,
		status,
		json: async () => (typeof body === "string" ? JSON.parse(body) : body),
		text: async () => text,
	} as never;
}

/** Raw GitHub API repo fixture. */
const ghRepo = {
	id: 12345,
	name: "infra",
	full_name: "acme/infra",
	html_url: "https://github.com/acme/infra",
	private: true,
	default_branch: "main",
};
/** Raw GitLab API project fixture (visibility-driven privacy, optional branch). */
const glRepo = {
	id: 67890,
	name: "platform",
	path_with_namespace: "acme/platform",
	web_url: "https://gitlab.com/acme/platform",
	visibility: "private",
	default_branch: "develop",
};
/** Raw Bitbucket API repo fixture (uuid id, nested links/mainbranch). */
const bbRepo = {
	uuid: "{abc-123}",
	name: "svc",
	full_name: "team/svc",
	is_private: false,
	mainbranch: { name: "trunk" },
	links: { html: { href: "https://bitbucket.org/team/svc" } },
};

beforeEach(() => {
	vi.clearAllMocks();
	vi.stubGlobal("fetch", fetchMock);
	// Silence the SUT's expected console.error in error-path tests.
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.mocked(getGitlabBaseUrl).mockReturnValue("https://gitlab.com");
});

describe("fetchAllRepositories", () => {
	it("returns an empty list and never calls fetch when no providers are linked", async () => {
		vi.mocked(getLinkedProviders).mockResolvedValue([]);
		const r = await fetchAllRepositories();
		expect(r).toEqual({ repositories: [] });
		expect(getValidProviderToken).not.toHaveBeenCalled();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("maps GitHub repos and sends the Bearer token to the GitHub API", async () => {
		vi.mocked(getLinkedProviders).mockResolvedValue(["github"] as never);
		vi.mocked(getValidProviderToken).mockResolvedValue("gh-token");
		fetchMock.mockResolvedValue(res([ghRepo]));

		const r = await fetchAllRepositories();

		expect(r.error).toBeUndefined();
		expect(r.repositories).toEqual([
			{
				id: "12345",
				name: "infra",
				full_name: "acme/infra",
				url: "https://github.com/acme/infra",
				private: true,
				default_branch: "main",
				provider: "github",
			},
		]);
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe(
			"https://api.github.com/user/repos?per_page=100&sort=updated",
		);
		expect((init as RequestInit).headers).toMatchObject({
			Authorization: "Bearer gh-token",
			Accept: "application/vnd.github.v3+json",
		});
	});

	it("maps GitLab projects (visibility->private, default_branch fallback) via the configured base URL", async () => {
		vi.mocked(getLinkedProviders).mockResolvedValue(["gitlab"] as never);
		vi.mocked(getValidProviderToken).mockResolvedValue("gl-token");
		// visibility "public" -> private:false; missing default_branch -> "main".
		fetchMock.mockResolvedValue(
			res([{ ...glRepo, visibility: "public", default_branch: undefined }]),
		);

		const r = await fetchAllRepositories();

		expect(r.repositories[0]).toEqual({
			id: "67890",
			name: "platform",
			full_name: "acme/platform",
			url: "https://gitlab.com/acme/platform",
			private: false,
			default_branch: "main",
			provider: "gitlab",
		});
		expect(fetchMock.mock.calls[0][0]).toBe(
			"https://gitlab.com/api/v4/projects?membership=true&per_page=100&order_by=updated_at",
		);
	});

	it("maps Bitbucket repos and tolerates a missing values array", async () => {
		vi.mocked(getLinkedProviders).mockResolvedValue(["bitbucket"] as never);
		vi.mocked(getValidProviderToken).mockResolvedValue("bb-token");
		fetchMock.mockResolvedValue(res({ values: [bbRepo] }));

		const r = await fetchAllRepositories();
		expect(r.repositories[0]).toEqual({
			id: "{abc-123}",
			name: "svc",
			full_name: "team/svc",
			url: "https://bitbucket.org/team/svc",
			private: false,
			default_branch: "trunk",
			provider: "bitbucket",
		});
	});

	it("aggregates repos across multiple linked providers", async () => {
		vi.mocked(getLinkedProviders).mockResolvedValue([
			"github",
			"gitlab",
		] as never);
		vi.mocked(getValidProviderToken).mockResolvedValue("tok");
		fetchMock.mockImplementation((u: string) =>
			Promise.resolve(
				u.includes("github") ? res([ghRepo]) : res([glRepo]),
			),
		);

		const r = await fetchAllRepositories();
		expect(r.repositories.map((x) => x.provider).sort()).toEqual([
			"github",
			"gitlab",
		]);
	});

	it("skips a provider whose token is null without fetching it", async () => {
		vi.mocked(getLinkedProviders).mockResolvedValue(["github"] as never);
		vi.mocked(getValidProviderToken).mockResolvedValue(null);

		const r = await fetchAllRepositories();
		expect(r).toEqual({ repositories: [] });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("contributes nothing for a provider whose API responds non-ok", async () => {
		vi.mocked(getLinkedProviders).mockResolvedValue(["github"] as never);
		vi.mocked(getValidProviderToken).mockResolvedValue("gh-token");
		fetchMock.mockResolvedValue(res("nope", { ok: false, status: 500 }));

		const r = await fetchAllRepositories();
		expect(r).toEqual({ repositories: [] });
	});

	it("isolates a per-provider throw so other providers still resolve", async () => {
		vi.mocked(getLinkedProviders).mockResolvedValue([
			"github",
			"gitlab",
		] as never);
		vi.mocked(getValidProviderToken).mockResolvedValue("tok");
		fetchMock.mockImplementation((u: string) =>
			u.includes("github")
				? Promise.reject(new Error("boom"))
				: Promise.resolve(res([glRepo])),
		);

		const r = await fetchAllRepositories();
		expect(r.repositories).toHaveLength(1);
		expect(r.repositories[0].provider).toBe("gitlab");
	});

	it("maps an outer failure (getLinkedProviders throws) to a generic error", async () => {
		vi.mocked(getLinkedProviders).mockRejectedValue(new Error("session gone"));
		const r = await fetchAllRepositories();
		expect(r).toEqual({
			repositories: [],
			error: "Failed to fetch repositories",
		});
	});
});

describe("createRepository", () => {
	it("rejects an unauthenticated caller before touching token/fetch", async () => {
		vi.mocked(getOwner).mockResolvedValue(null as never);
		const r = await createRepository("github", { name: "x" });
		expect(r).toEqual({ error: "Unauthorized" });
		expect(getValidProviderToken).not.toHaveBeenCalled();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("returns a link-account error when no provider token is available", async () => {
		vi.mocked(getOwner).mockResolvedValue("user-1" as never);
		vi.mocked(getValidProviderToken).mockResolvedValue(null);
		const r = await createRepository("github", { name: "x" });
		expect(r).toEqual({
			error: "No github token found. Please link your github account.",
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("validates a required GitHub name before any fetch", async () => {
		vi.mocked(getOwner).mockResolvedValue("user-1" as never);
		vi.mocked(getValidProviderToken).mockResolvedValue("gh-token");
		const r = await createRepository("github", { name: "" });
		expect(r).toEqual({ error: "Repository name is required." });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("creates a GitHub repo (POST private:false) and maps the response", async () => {
		vi.mocked(getOwner).mockResolvedValue("user-1" as never);
		vi.mocked(getValidProviderToken).mockResolvedValue("gh-token");
		fetchMock.mockResolvedValue(res(ghRepo));

		const r = await createRepository("github", { name: "infra" });
		expect(r.error).toBeUndefined();
		expect(r.repository).toEqual({
			id: "12345",
			name: "infra",
			full_name: "acme/infra",
			url: "https://github.com/acme/infra",
			private: true,
			default_branch: "main",
			provider: "github",
		});
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe("https://api.github.com/user/repos");
		const i = init as RequestInit;
		expect(i.method).toBe("POST");
		expect(JSON.parse(i.body as string)).toEqual({
			name: "infra",
			private: false,
		});
	});

	it("surfaces the GitHub API error message on a non-ok create", async () => {
		vi.mocked(getOwner).mockResolvedValue("user-1" as never);
		vi.mocked(getValidProviderToken).mockResolvedValue("gh-token");
		fetchMock.mockResolvedValue(
			res({ message: "name already exists" }, { ok: false, status: 422 }),
		);
		const r = await createRepository("github", { name: "dup" });
		expect(r).toEqual({
			error: "Failed to create GitHub repository: name already exists",
		});
	});

	it("creates a GitLab repo (visibility public) and maps the response", async () => {
		vi.mocked(getOwner).mockResolvedValue("user-1" as never);
		vi.mocked(getValidProviderToken).mockResolvedValue("gl-token");
		fetchMock.mockResolvedValue(res({ ...glRepo, visibility: "public" }));

		const r = await createRepository("gitlab", { name: "platform" });
		expect(r.repository).toMatchObject({
			id: "67890",
			full_name: "acme/platform",
			url: "https://gitlab.com/acme/platform",
			private: false,
			provider: "gitlab",
		});
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe("https://gitlab.com/api/v4/projects");
		expect(JSON.parse((init as RequestInit).body as string)).toEqual({
			name: "platform",
			visibility: "public",
		});
	});

	it("extracts the nested GitLab validation message on a non-ok create", async () => {
		vi.mocked(getOwner).mockResolvedValue("user-1" as never);
		vi.mocked(getValidProviderToken).mockResolvedValue("gl-token");
		fetchMock.mockResolvedValue(
			res(
				{ message: { name: ["has already been taken"] } },
				{ ok: false, status: 400 },
			),
		);
		const r = await createRepository("gitlab", { name: "dup" });
		expect(r).toEqual({
			error: "Failed to create GitLab repository: has already been taken",
		});
	});

	it("requires name+workspace+projectKey for Bitbucket before any fetch", async () => {
		vi.mocked(getOwner).mockResolvedValue("user-1" as never);
		vi.mocked(getValidProviderToken).mockResolvedValue("bb-token");
		const r = await createRepository("bitbucket", { name: "svc" }); // missing workspace/projectKey
		expect(r).toEqual({
			error: "Repository name, workspace, and project key are required.",
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("SSRF/path-injection: encodeURIComponent-escapes the user workspace+name in the Bitbucket URL", async () => {
		vi.mocked(getOwner).mockResolvedValue("user-1" as never);
		vi.mocked(getValidProviderToken).mockResolvedValue("bb-token");
		fetchMock.mockResolvedValue(res(bbRepo));

		await createRepository("bitbucket", {
			name: "../../../admin",
			workspace: "../../evil",
			projectKey: "KEY",
		});

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const calledUrl = fetchMock.mock.calls[0][0] as string;
		// The traversal/slash characters MUST be percent-encoded so they cannot escape
		// the /repositories/{workspace}/{name} path segment.
		expect(calledUrl).toBe(
			"https://api.bitbucket.org/2.0/repositories/..%2F..%2Fevil/..%2F..%2F..%2Fadmin",
		);
		// Defensive: no raw traversal sequence survives into the request URL (only the single
		// legitimate `/` between the {workspace} and {name} path segments remains).
		expect(calledUrl).not.toContain("../");
	});

	it("creates a Bitbucket repo and maps the uuid/links/mainbranch response", async () => {
		vi.mocked(getOwner).mockResolvedValue("user-1" as never);
		vi.mocked(getValidProviderToken).mockResolvedValue("bb-token");
		fetchMock.mockResolvedValue(res(bbRepo));

		const r = await createRepository("bitbucket", {
			name: "svc",
			workspace: "team",
			projectKey: "KEY",
		});
		expect(r.repository).toEqual({
			id: "{abc-123}",
			name: "svc",
			full_name: "team/svc",
			url: "https://bitbucket.org/team/svc",
			private: false,
			default_branch: "trunk",
			provider: "bitbucket",
		});
		const init = fetchMock.mock.calls[0][1] as RequestInit;
		expect(JSON.parse(init.body as string)).toEqual({
			scm: "git",
			project: { key: "KEY" },
			is_private: false,
		});
	});

	it("surfaces the nested Bitbucket error message on a non-ok create", async () => {
		vi.mocked(getOwner).mockResolvedValue("user-1" as never);
		vi.mocked(getValidProviderToken).mockResolvedValue("bb-token");
		fetchMock.mockResolvedValue(
			res({ error: { message: "repo exists" } }, { ok: false, status: 400 }),
		);
		const r = await createRepository("bitbucket", {
			name: "svc",
			workspace: "team",
			projectKey: "KEY",
		});
		expect(r).toEqual({
			error: "Failed to create Bitbucket repository: repo exists",
		});
	});

	it("surfaces a flat Bitbucket error body's message (regression: was unsafe nested access)", async () => {
		vi.mocked(getOwner).mockResolvedValue("user-1" as never);
		vi.mocked(getValidProviderToken).mockResolvedValue("bb-token");
		// Real Bitbucket also returns flat `{ type, message }` / `{ error_description }` shapes.
		// The fixed action reads them safely instead of throwing into the generic catch.
		fetchMock.mockResolvedValue(
			res({ type: "error", message: "bad" }, { ok: false, status: 400 }),
		);
		const r = await createRepository("bitbucket", {
			name: "svc",
			workspace: "team",
			projectKey: "KEY",
		});
		expect(r).toEqual({ error: "Failed to create Bitbucket repository: bad" });
	});

	it("returns 'Unsupported provider' for an unknown provider", async () => {
		vi.mocked(getOwner).mockResolvedValue("user-1" as never);
		vi.mocked(getValidProviderToken).mockResolvedValue("tok");
		const r = await createRepository("gitea" as never, { name: "x" });
		expect(r).toEqual({ error: "Unsupported provider" });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("maps a thrown fetch (network) into the generic create error", async () => {
		vi.mocked(getOwner).mockResolvedValue("user-1" as never);
		vi.mocked(getValidProviderToken).mockResolvedValue("gh-token");
		fetchMock.mockRejectedValue(new Error("ECONNRESET"));
		const r = await createRepository("github", { name: "infra" });
		expect(r).toEqual({ error: "Failed to create repository" });
	});
});

describe("fetchRepositoriesByProvider", () => {
	it("returns a missing_token result without fetching when no token", async () => {
		vi.mocked(getValidProviderToken).mockResolvedValue(null);
		const r = await fetchRepositoriesByProvider("github");
		expect(r).toEqual({
			repositories: [],
			error: "No token found for github",
			authErrorCode: "missing_token",
			authProvider: "github",
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("maps a successful GitHub fetch", async () => {
		vi.mocked(getValidProviderToken).mockResolvedValue("gh-token");
		fetchMock.mockResolvedValue(res([ghRepo]));
		const r = await fetchRepositoriesByProvider("github");
		expect(r.error).toBeUndefined();
		expect(r.repositories).toHaveLength(1);
		expect(r.repositories[0].id).toBe("12345");
	});

	it("flags a GitHub 401 as unauthorized with the provider attached", async () => {
		vi.mocked(getValidProviderToken).mockResolvedValue("gh-token");
		fetchMock.mockResolvedValue(res("bad creds", { ok: false, status: 401 }));
		const r = await fetchRepositoriesByProvider("github");
		expect(r.repositories).toEqual([]);
		expect(r.authErrorCode).toBe("unauthorized");
		expect(r.authProvider).toBe("github");
		expect(r.error).toContain("Failed to fetch GitHub repos: bad creds");
	});

	it("does NOT set an auth-error code for a non-401 GitHub failure", async () => {
		vi.mocked(getValidProviderToken).mockResolvedValue("gh-token");
		fetchMock.mockResolvedValue(res("oops", { ok: false, status: 500 }));
		const r = await fetchRepositoriesByProvider("github");
		expect(r.authErrorCode).toBeUndefined();
		expect(r.authProvider).toBeUndefined();
	});

	it("maps a successful GitLab fetch via the configured base URL", async () => {
		vi.mocked(getValidProviderToken).mockResolvedValue("gl-token");
		fetchMock.mockResolvedValue(res([glRepo]));
		const r = await fetchRepositoriesByProvider("gitlab");
		expect(r.repositories[0].full_name).toBe("acme/platform");
		expect(fetchMock.mock.calls[0][0]).toContain(
			"https://gitlab.com/api/v4/projects",
		);
	});

	it("classifies a Bitbucket expired-token 401 as token_expired", async () => {
		vi.mocked(getValidProviderToken).mockResolvedValue("bb-token");
		fetchMock.mockResolvedValue(
			res("OAuth2 access token expired", { ok: false, status: 401 }),
		);
		const r = await fetchRepositoriesByProvider("bitbucket");
		expect(r.authErrorCode).toBe("token_expired");
		expect(r.authProvider).toBe("bitbucket");
	});

	it("classifies a generic Bitbucket 401 as unauthorized (not expired)", async () => {
		vi.mocked(getValidProviderToken).mockResolvedValue("bb-token");
		fetchMock.mockResolvedValue(res("forbidden", { ok: false, status: 401 }));
		const r = await fetchRepositoriesByProvider("bitbucket");
		expect(r.authErrorCode).toBe("unauthorized");
	});

	it("maps a thrown fetch to the error message and an empty list", async () => {
		vi.mocked(getValidProviderToken).mockResolvedValue("gh-token");
		fetchMock.mockRejectedValue(new Error("DNS failure"));
		const r = await fetchRepositoriesByProvider("github");
		expect(r).toEqual({ repositories: [], error: "DNS failure" });
	});
});
