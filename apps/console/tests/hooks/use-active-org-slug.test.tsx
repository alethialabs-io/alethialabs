// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Regression cover for #4089 — a Next prefetch of a sidebar link moved the session's tenant.
//
// The chain: `useActiveOrgSlug` read the workspace store alone, and `activeOrgId` is null until
// `fetchWorkspace()` resolves, so the lookup missed and it returned the reserved personal `~` for
// "still loading" as well as for "actually personal". During hydration the sidebar therefore
// painted `/~/~/…` hrefs while the address bar said `/acme/…`. Next prefetches every link in the
// viewport; each prefetch renders `app/(private)/[org]/layout.tsx`; that layout calls
// `resolveOrgScope("~")`, which WRITES `session.active_organization_id`. A speculative GET the
// user never made moved their tenant, and their next write landed in the personal org — invisible
// to the org and every teammate, with no error. Run 33710964528's trace caught 36 `/~/~/`
// requests, every one carrying `next-router-prefetch: 1`, none of them a navigation.
//
// ## What these tests prove, and what they do NOT
//
// They do NOT drive a prefetch. A prefetch is an HTTP request shape, and there is no tier
// available here that issues one: the console cannot run on this machine, and even in a running
// console the distinguishing header is invisible to application code — Next 16.3.3 puts
// `next-router-prefetch` in `FLIGHT_HEADERS`, which `request-store.js` seals out of the view
// `headers()` returns (`.get()` → null) and `web/adapter.js` deletes before `proxy.ts` sees the
// request. So "a prefetch did not write" is not directly assertable at any layer, in a test or in
// production code. That is precisely why the fix is not a guard on the write.
//
// What IS assertable is the invariant that makes a speculative resolve harmless: every
// prefetchable href names the org the address bar already names, so the resolve can only
// re-assert the org the user is already in — the same value a real navigation would write. These
// tests pin that invariant at the one place the two could disagree, which is the hook that builds
// the hrefs. `tests/actions/resolve.test.ts` pins the other half: that the resolve writes at all,
// on both branches, so the invariant is load-bearing rather than decorative.

import { readFile } from "node:fs/promises";
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The org segment of the current URL. `useParams()` returns null outside a router context, which
// is a state the hook must survive — `null` here models that.
let params: Record<string, string | string[]> | null = null;

vi.mock("next/navigation", () => ({
	useParams: () => params,
}));

// The store imports the workspace server actions purely to call them; the hook under test never
// does. Stub the module so importing the store does not drag the DB/auth closure into jsdom.
vi.mock("@/app/server/actions/workspace", () => ({
	getWorkspaceContext: vi.fn(),
	setActiveOrganization: vi.fn(),
}));

import {
	useActiveOrgSlug,
	useWorkspaceStore,
} from "@/lib/stores/use-workspace-store";

/** The store as it is on first paint: fetchWorkspace() has not resolved yet. */
function storeIsLoading() {
	useWorkspaceStore.setState({
		activeOrgId: null,
		organizations: [],
		isLoading: true,
	});
}

/** The store after fetchWorkspace() resolved, scoped to `activeOrgId`. */
function storeLoaded(activeOrgId: string) {
	useWorkspaceStore.setState({
		activeOrgId,
		organizations: [
			{
				id: "org-acme",
				name: "Acme",
				slug: "acme",
				logo: null,
				role: "owner",
				plan: "community",
				status: "none",
			},
			{
				id: "org-other",
				name: "Other",
				slug: "other",
				logo: null,
				role: "member",
				plan: "community",
				status: "none",
			},
		],
		isLoading: false,
	});
}

beforeEach(() => {
	params = null;
	storeIsLoading();
});

describe("useActiveOrgSlug — the href agrees with the address bar (#4089)", () => {
	it("returns the URL's org while the workspace is still loading, never `~`", () => {
		// The exact defect window. Before the fix this returned `~`, the sidebar painted
		// `/~/~/…`, and Next prefetched a URL that re-scoped the session to personal.
		params = { org: "acme" };
		storeIsLoading();

		const { result } = renderHook(() => useActiveOrgSlug());

		expect(result.current).toBe("acme");
		expect(result.current).not.toBe("~");
	});

	it("returns the URL's org when the loaded session names a DIFFERENT one", () => {
		// The other disagreement window: mid-switch, or a session whose stored active org is
		// stale. The URL is what the user is looking at, so the URL wins — an href built from
		// the session would point at a tenant the address bar does not name, and prefetching
		// it would move them there.
		params = { org: "acme" };
		storeLoaded("org-other");

		const { result } = renderHook(() => useActiveOrgSlug());

		expect(result.current).toBe("acme");
	});

	it("returns `~` for the personal scope because the URL says `~`, not because it is loading", () => {
		// Same value as the defect produced, reached honestly: the address bar really does say
		// `~`, so a prefetch re-asserts personal scope, which is where the user already is.
		params = { org: "~" };
		storeIsLoading();

		const { result } = renderHook(() => useActiveOrgSlug());

		expect(result.current).toBe("~");
	});

	it("keeps the URL's org for a project drilldown, where params carry more than `org`", () => {
		params = { org: "acme", project: "checkout", env: "prod" };
		storeLoaded("org-acme");

		const { result } = renderHook(() => useActiveOrgSlug());

		expect(result.current).toBe("acme");
	});
});

describe("useActiveOrgSlug — the session fallback, off the `[org]` shell", () => {
	it("falls back to the session's org where the route has no `[org]` segment", () => {
		// `/onboarding`, `/dashboard`, the CLI hand-off: useParams() has no `org` to give and
		// the session's selection is the only answer available.
		params = {};
		storeLoaded("org-acme");

		const { result } = renderHook(() => useActiveOrgSlug());

		expect(result.current).toBe("acme");
	});

	it("falls back to `~` off the shell when the session names no org", () => {
		params = {};
		storeIsLoading();

		const { result } = renderHook(() => useActiveOrgSlug());

		expect(result.current).toBe("~");
	});

	it("survives a null useParams() (no router context) without throwing", () => {
		params = null;
		storeLoaded("org-acme");

		const { result } = renderHook(() => useActiveOrgSlug());

		expect(result.current).toBe("acme");
	});

	it("ignores a catch-all segment's string[] rather than stringifying it into an href", () => {
		params = { org: ["a", "b"] };
		storeLoaded("org-acme");

		const { result } = renderHook(() => useActiveOrgSlug());

		expect(result.current).toBe("acme");
	});
});

describe("the client Router Cache must not serve `/{org}/…` (#4089)", () => {
	// The invisible assumption the whole fix rides on. Re-scoping the session happens ONLY
	// because Next 16's default `staleTimes.dynamic = 0` re-runs the dynamic segment on every
	// navigation. Setting `staleTimes.dynamic > 0` serves `/{org}/…` from the client Router
	// Cache, `[org]/layout.tsx` does not re-run, and the session is then never re-scoped on a
	// soft navigation between two orgs — the user keeps writing into whichever org they were
	// last hard-loaded under. Nothing errors and no check goes red, so this is the check.
	//
	// It reads the config as SOURCE rather than importing it: `next.config.ts` runs
	// `withPostHogConfig` and env-dependent origin resolution at module scope, and neither is
	// worth booting to answer a one-key question. The cost is that it matches text, so it looks
	// for an assignment (`staleTimes:`) rather than a mention — the prose above the key in
	// next.config.ts names `staleTimes` several times and must not trip it.
	it("next.config.ts sets no experimental.staleTimes", async () => {
		const source = await readFile(
			new URL("../../next.config.ts", import.meta.url),
			"utf8",
		);
		// Strip comments before matching. The `[^:]` guard keeps `https://…` inside a string
		// literal from being read as the start of a line comment.
		const code = source
			.replace(/(^|[^:])\/\/.*$/gm, "$1")
			.replace(/\/\*[\s\S]*?\*\//g, "");

		// Controls: a stripper that ate the file would make the assertion below vacuously true.
		expect(code.length).toBeGreaterThan(500);
		expect(code).toMatch(/serverActions\s*:/);

		expect(code).not.toMatch(/staleTimes\s*:/);
	});
});
