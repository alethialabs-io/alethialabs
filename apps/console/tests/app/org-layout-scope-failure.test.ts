// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #5001: `[org]/layout.tsx` turned EVERY `resolveOrgScope` failure except one message into
// `notFound()`. A transient failure told a user their own org "doesn't exist, or you don't have
// access to it", and the real error was never logged.
//
// These tests call the layout itself with `resolveOrgScope` stubbed. Next's real `notFound()` and
// `redirect()` run, and each answer is read off the thrown value's `digest`, which is how Next
// itself tells a 404 from a redirect from an error. A mocked `notFound` would only show that a
// function was called.
//
// #6756: a request with no session is redirected to sign-in WITH the address it was for, read from
// the header the proxy publishes the path on.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { notFound } from "next/navigation";

vi.mock("@/app/server/actions/resolve", () => ({ resolveOrgScope: vi.fn() }));
vi.mock("@/lib/auth/owner", () => ({ getOwner: vi.fn() }));
// The page's actor: in community it collapses to the personal org (`orgId === userId`).
vi.mock("@/lib/authz/guard", () => ({
	currentActor: vi.fn(async () => ({ userId: "user-1", orgId: "user-1" })),
}));
// The instance edition the layout hands the shell (#6924): a community build its operator runs.
// The real reader loads the enterprise registration, which is not what is under test here.
vi.mock("@/lib/edition/instance-edition", () => ({
	getInstanceEdition: vi.fn(async () => ({
		deployment: "self-managed",
		edition: "community",
		offering: "self-hosted",
		license: { state: "none", subject: null, tier: null, expiresAt: null, graceEndsAt: null },
		capabilitySource: "community",
		capabilities: [],
		features: [],
		diagnostic: "ok",
	})),
}));
vi.mock("@/lib/queries/runner-capabilities", () => ({
	orgHasSelfRunners: vi.fn(async () => false),
}));
// The chrome is irrelevant here, and importing the real shell pulls in the whole client graph.
vi.mock("@/components/shell/app-shell", () => ({ AppShell: () => null }));
// The path the proxy published for this request (`x-alethia-path`); null when it published none.
const request = vi.hoisted((): { path: string | null } => ({ path: "/acme/~/jobs" }));
vi.mock("next/headers", () => ({
	headers: async () => new Headers(request.path === null ? {} : { "x-alethia-path": request.path }),
}));
vi.mock("@/components/org/upgrade-sheet-provider", () => ({
	UpgradeSheetProvider: () => null,
}));
// The shell's prefetch (#6114) goes through the in-process read router; here every procedure
// answers null without touching a database — what is under test is the scope failure, not the data.
vi.mock("@/lib/rpc/server", () => ({
	serverOrpc: () => ({
		workspace: new Proxy(
			{},
			{
				get: (_target, name) => ({
					queryOptions: () => ({ queryKey: [["workspace", String(name)]], queryFn: async () => null }),
				}),
			},
		),
	}),
}));

import OrgLayout from "@/app/(private)/[org]/layout";
import { resolveOrgScope } from "@/app/server/actions/resolve";
import { NotOrgMemberError, UnauthorizedError } from "@/lib/auth/errors";
import { getOwner } from "@/lib/auth/owner";
import { classifyOrgScopeFailure } from "@/lib/auth/org-scope-failure";

/** Renders the layout for `/acme` and returns what it threw (or `null` if it rendered). */
async function thrownBy(): Promise<unknown> {
	try {
		await OrgLayout({ children: null, params: Promise.resolve({ org: "acme" }) });
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

/** The digest `notFound()` throws: `(private)/not-found.tsx` renders "Organization not found". */
const NOT_FOUND = "NEXT_HTTP_ERROR_FALLBACK;404";

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(getOwner).mockResolvedValue("user-1");
	request.path = "/acme/~/jobs";
});

describe("[org]/layout — what a resolveOrgScope failure renders", () => {
	it("renders the shell when the org resolves", async () => {
		vi.mocked(resolveOrgScope).mockResolvedValue({ orgId: "org-1", isPersonal: false });
		await expect(thrownBy()).resolves.toBeNull();
	});

	it("hands the shell the page's currentActor().orgId, not resolveOrgScope's id (ADR 0003 §6.1)", async () => {
		// Community, a team-org URL: the real org's id would be refused by the turn resolver.
		vi.mocked(resolveOrgScope).mockResolvedValue({ orgId: "org-1", isPersonal: false });
		const tree = await OrgLayout({ children: null, params: Promise.resolve({ org: "acme" }) });
		// HydrationBoundary (the shell's prefetch, #6114) → UpgradeSheetProvider → AppShell.
		const shell: unknown = tree.props.children.props.children;
		expect(shell).toMatchObject({ props: { pageOrgId: "user-1" } });
	});

	it("hands the shell the instance edition's deployment, build and offering, and nothing of the licence", async () => {
		vi.mocked(resolveOrgScope).mockResolvedValue({ orgId: "org-1", isPersonal: false });
		const tree = await OrgLayout({ children: null, params: Promise.resolve({ org: "acme" }) });
		const shell: unknown = tree.props.children.props.children;
		expect(shell).toMatchObject({
			props: {
				edition: { deployment: "self-managed", edition: "community", offering: "self-hosted" },
			},
		});
		// The slice is exactly those three: the licence's subject and dates stay on the server.
		const props: unknown =
			typeof shell === "object" && shell !== null && "props" in shell ? shell.props : null;
		const edition: unknown =
			typeof props === "object" && props !== null && "edition" in props ? props.edition : null;
		expect(Object.keys(typeof edition === "object" && edition !== null ? edition : {}).sort()).toEqual(
			["deployment", "edition", "offering"],
		);
	});

	// ── The two failures that are TRUE statements about the org → the org 404 ────────────────

	it("an unknown slug stays a 404 — resolveOrgScope's own notFound() passes through", async () => {
		vi.mocked(resolveOrgScope).mockImplementation(async () => notFound());
		expect(digestOf(await thrownBy())).toBe(NOT_FOUND);
	});

	it("a membership that vanished before the session write is a 404 too", async () => {
		vi.mocked(resolveOrgScope).mockRejectedValue(new NotOrgMemberError());
		expect(digestOf(await thrownBy())).toBe(NOT_FOUND);
	});

	// ── No session → sign-in, coming back to the address the request was for (#6756) ──────────

	it("a session lost mid-request is sign-in with this address as `next`, not a 404", async () => {
		vi.mocked(resolveOrgScope).mockRejectedValue(new UnauthorizedError());
		const digest = digestOf(await thrownBy()) ?? "";
		expect(digest.startsWith("NEXT_REDIRECT;")).toBe(true);
		expect(digest).toContain("/login?next=%2Facme%2F~%2Fjobs;");
	});

	it("a request with no session at all is the same redirect, before the org is resolved", async () => {
		vi.mocked(getOwner).mockResolvedValue(null);
		const digest = digestOf(await thrownBy()) ?? "";
		expect(digest.startsWith("NEXT_REDIRECT;")).toBe(true);
		expect(digest).toContain("/login?next=%2Facme%2F~%2Fjobs;");
		expect(resolveOrgScope).not.toHaveBeenCalled();
	});

	it.each([
		["no published path", null],
		["a published path that is not a safe destination", "//elsewhere.test/acme"],
	])("with %s it is plain sign-in", async (_, path) => {
		request.path = path;
		vi.mocked(getOwner).mockResolvedValue(null);
		const digest = digestOf(await thrownBy()) ?? "";
		expect(digest.startsWith("NEXT_REDIRECT;")).toBe(true);
		expect(digest).toContain(";/login;");
	});

	// ── Everything else is NOT a statement about the org → the error boundary ─────────────────

	it.each([
		["a dropped database connection", new Error("Connection terminated unexpectedly")],
		["a failed query", new Error('relation "member" does not exist')],
		["a non-Error throw", "boom"],
	])("%s is rethrown as it is, not turned into 'Organization not found'", async (_, failure) => {
		vi.mocked(resolveOrgScope).mockRejectedValue(failure);
		const thrown = await thrownBy();
		// The SAME value: it reaches the error boundary and onRequestError logs it.
		expect(thrown).toBe(failure);
		expect(digestOf(thrown)).toBeUndefined();
	});
});

describe("classifyOrgScopeFailure", () => {
	it("names the two failures that have a page of their own", () => {
		expect(classifyOrgScopeFailure(new UnauthorizedError())).toBe("sign-in");
		expect(classifyOrgScopeFailure(new NotOrgMemberError())).toBe("not-found");
	});

	it("keeps the messages the untyped errors carried, which isExpectedRequestError reads", () => {
		expect(new UnauthorizedError().message).toBe("Unauthorized");
		expect(new NotOrgMemberError().message).toBe("Not a member of that organization");
	});

	it("does not classify by message: an untyped 'Unauthorized' is rethrown", () => {
		const untyped = new Error("Unauthorized");
		expect(() => classifyOrgScopeFailure(untyped)).toThrow(untyped);
	});
});
