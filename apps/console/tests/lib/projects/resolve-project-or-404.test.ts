// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// CON-SM4 (#6813): every `[project]` page and the `[project]` layout wrapped `resolveProjectId` in a
// bare `catch { notFound() }`, so a lost session and a failed query were both answered "Project not
// found", with no retry and nothing logged.
//
// `resolveProjectId` is stubbed; Next's real `notFound()` and `redirect()` run, and each answer is
// read off the thrown value's `digest`, which is how Next itself tells a 404 from a redirect from
// an error (the same method as tests/app/org-layout-scope-failure.test.ts). A mocked `notFound`
// would only show that a function was called.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { notFound, redirect } from "next/navigation";

vi.mock("@/app/server/actions/resolve", () => ({ resolveProjectId: vi.fn() }));
// The path the proxy published for this request (`x-alethia-path`); null when it published none.
const request = vi.hoisted((): { path: string | null } => ({ path: "/acme/payments/jobs" }));
vi.mock("next/headers", () => ({
	headers: async () => new Headers(request.path === null ? {} : { "x-alethia-path": request.path }),
}));
// The layout's and the page's own work is not under test, and their real modules pull in the
// database and the whole client graph.
vi.mock("@/app/server/actions/aws/identities", () => ({
	getVerifiedCloudIdentities: vi.fn(async () => []),
}));
vi.mock("@/components/design-project/project-shell", () => ({ ProjectShell: () => null }));
vi.mock("@/lib/rpc/server", () => ({
	serverOrpc: () => ({
		workspace: {
			environments: {
				queryOptions: () => ({ queryKey: [["workspace", "environments"]], queryFn: async () => [] }),
			},
		},
		clusters: {
			// The clusters route prefetches the first KEYSET page (components/clusters/clusters-prefetch.ts).
			page: {
				infiniteOptions: () => ({
					queryKey: [["clusters", "page"], { type: "infinite" }],
					queryFn: async () => ({ rows: [], nextCursor: null }),
					initialPageParam: null,
					getNextPageParam: () => null,
				}),
			},
			detail: { queryOptions: () => ({ queryKey: [["clusters", "detail"]], queryFn: async () => null }) },
		},
	}),
}));
vi.mock("@/app/(private)/[org]/~/clusters/clusters-client", () => ({ ClustersClient: () => null }));

import ProjectClustersPage from "@/app/(private)/[org]/[project]/clusters/page";
import ProjectLayout from "@/app/(private)/[org]/[project]/layout";
import { resolveProjectId } from "@/app/server/actions/resolve";
import { NotOrgMemberError, UnauthorizedError } from "@/lib/auth/errors";
import {
	classifyProjectResolveFailure,
	resolveProjectOr404,
} from "@/lib/projects/resolve-project-or-404";

/** Runs `run` and returns what it threw, or `null` if it returned. */
async function thrownBy(run: () => Promise<unknown>): Promise<unknown> {
	try {
		await run();
		return null;
	} catch (e) {
		return e;
	}
}

/** The `digest` Next puts on its control-flow throws, or undefined for an ordinary error. */
function digestOf(e: unknown): string | undefined {
	return typeof e === "object" && e !== null && "digest" in e && typeof e.digest === "string"
		? e.digest
		: undefined;
}

/** The digest `notFound()` throws: `[project]/not-found.tsx` renders "Project not found". */
const NOT_FOUND = "NEXT_HTTP_ERROR_FALLBACK;404";

/** The failures that say nothing about the project, so must reach the error boundary unchanged. */
const REAL_FAILURES: [string, unknown][] = [
	["a dropped database connection", new Error("Connection terminated unexpectedly")],
	["a failed query", new Error('relation "projects" does not exist')],
	["a refusal that is not about the session", new NotOrgMemberError()],
	["an untyped error whose message says Unauthorized", new Error("Unauthorized")],
	["a non-Error throw", "boom"],
];

const params = Promise.resolve({ org: "acme", project: "payments" });
/** A pristine link: the route reads its filters from the query string (#6819). */
const searchParams = Promise.resolve({});

beforeEach(() => {
	vi.clearAllMocks();
	request.path = "/acme/payments/jobs";
});

describe("resolveProjectOr404", () => {
	it("answers the project's id when the slug resolves", async () => {
		vi.mocked(resolveProjectId).mockResolvedValue("proj-1");
		await expect(resolveProjectOr404("payments")).resolves.toBe("proj-1");
		expect(resolveProjectId).toHaveBeenCalledWith("payments");
	});

	it("answers null — the caller's 404 — when resolveProjectId calls notFound()", async () => {
		vi.mocked(resolveProjectId).mockImplementation(async () => notFound());
		await expect(resolveProjectOr404("nope")).resolves.toBeNull();
	});

	it("a lost session is sign-in, coming back to the address the request was for", async () => {
		vi.mocked(resolveProjectId).mockRejectedValue(new UnauthorizedError());
		const digest = digestOf(await thrownBy(() => resolveProjectOr404("payments"))) ?? "";
		expect(digest.startsWith("NEXT_REDIRECT;")).toBe(true);
		expect(digest).toContain("/login?next=%2Facme%2Fpayments%2Fjobs;");
	});

	it.each([
		["no published path", null],
		["a published path that is not a safe destination", "//elsewhere.test/acme"],
	])("with %s a lost session is plain sign-in", async (_, path) => {
		request.path = path;
		vi.mocked(resolveProjectId).mockRejectedValue(new UnauthorizedError());
		const digest = digestOf(await thrownBy(() => resolveProjectOr404("payments"))) ?? "";
		expect(digest.startsWith("NEXT_REDIRECT;")).toBe(true);
		expect(digest).toContain(";/login;");
	});

	it.each(REAL_FAILURES)("%s is rethrown as it is, not turned into a 404", async (_, failure) => {
		vi.mocked(resolveProjectId).mockRejectedValue(failure);
		const thrown = await thrownBy(() => resolveProjectOr404("payments"));
		// The SAME value: it reaches the error boundary and onRequestError logs it.
		expect(thrown).toBe(failure);
		expect(digestOf(thrown)).toBeUndefined();
	});

	it("a redirect thrown inside the resolution passes through untouched", async () => {
		vi.mocked(resolveProjectId).mockImplementation(async () => redirect("/elsewhere"));
		const digest = digestOf(await thrownBy(() => resolveProjectOr404("payments"))) ?? "";
		expect(digest.startsWith("NEXT_REDIRECT;")).toBe(true);
		expect(digest).toContain(";/elsewhere;");
	});
});

describe("classifyProjectResolveFailure", () => {
	it("names the two failures that have an answer of their own", async () => {
		expect(classifyProjectResolveFailure(new UnauthorizedError())).toBe("sign-in");
		const notFoundThrow = await thrownBy(async () => notFound());
		expect(classifyProjectResolveFailure(notFoundThrow)).toBe("not-found");
	});

	it("does not read a 404 off an object that merely has some digest", () => {
		const other = Object.assign(new Error("boom"), { digest: "1234567890" });
		expect(() => classifyProjectResolveFailure(other)).toThrow(other);
	});

	it.each(REAL_FAILURES)("rethrows %s", (_, failure) => {
		let thrown: unknown = null;
		try {
			classifyProjectResolveFailure(failure);
		} catch (e) {
			thrown = e;
		}
		expect(thrown).toBe(failure);
	});
});

describe("a [project] page — what a failed resolution renders", () => {
	it("renders when the slug resolves", async () => {
		vi.mocked(resolveProjectId).mockResolvedValue("proj-1");
		await expect(thrownBy(() => ProjectClustersPage({ params, searchParams }))).resolves.toBeNull();
	});

	it("an unknown slug is the project 404, thrown by the page inside its own boundary", async () => {
		vi.mocked(resolveProjectId).mockImplementation(async () => notFound());
		expect(digestOf(await thrownBy(() => ProjectClustersPage({ params, searchParams })))).toBe(NOT_FOUND);
	});

	it("a lost session is sign-in, not 'Project not found'", async () => {
		vi.mocked(resolveProjectId).mockRejectedValue(new UnauthorizedError());
		const digest = digestOf(await thrownBy(() => ProjectClustersPage({ params, searchParams }))) ?? "";
		expect(digest.startsWith("NEXT_REDIRECT;")).toBe(true);
	});

	it.each(REAL_FAILURES)("%s reaches the error boundary, not 'Project not found'", async (_, failure) => {
		vi.mocked(resolveProjectId).mockRejectedValue(failure);
		expect(await thrownBy(() => ProjectClustersPage({ params, searchParams }))).toBe(failure);
	});
});

describe("[project]/layout — what a failed resolution renders", () => {
	it("an unknown slug renders the routed segment bare, so the page below answers the 404", async () => {
		vi.mocked(resolveProjectId).mockImplementation(async () => notFound());
		const tree = await ProjectLayout({ children: "the page", params });
		// A fragment around the children: no shell, and no throw that would escape the boundary.
		expect(tree).toMatchObject({ props: { children: "the page" } });
	});

	it("a resolved slug renders the project shell with its id", async () => {
		vi.mocked(resolveProjectId).mockResolvedValue("proj-1");
		const tree = await ProjectLayout({ children: "the page", params });
		// HydrationBoundary (the environments prefetch) → ProjectShell.
		expect(tree).toMatchObject({ props: { children: { props: { projectId: "proj-1" } } } });
	});

	it("a lost session is sign-in, not a page with no shell around it", async () => {
		vi.mocked(resolveProjectId).mockRejectedValue(new UnauthorizedError());
		const digest = digestOf(await thrownBy(() => ProjectLayout({ children: null, params }))) ?? "";
		expect(digest.startsWith("NEXT_REDIRECT;")).toBe(true);
		expect(digest).toContain("/login?next=%2Facme%2Fpayments%2Fjobs;");
	});

	it.each(REAL_FAILURES)("%s is rethrown, not swallowed into 'no project'", async (_, failure) => {
		vi.mocked(resolveProjectId).mockRejectedValue(failure);
		expect(await thrownBy(() => ProjectLayout({ children: null, params }))).toBe(failure);
	});
});
