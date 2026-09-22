// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The console filter standard's step 5, as BEHAVIOUR (#4890).
//
// `pnpm check:filter-standard` gates F3 and F6 by matching text — a `qk.*()` call carrying an
// identifier bound from `normalize*Query()`, and the literal `placeholderData: keepPreviousData`.
// That is the right shape for a guard over fifteen surfaces, and it is a rendering of the thing
// rather than the thing. What the standard actually promises is two facts a matcher cannot see:
//
//   F3 — two different filter states are two different CACHE ENTRIES. The defect it exists to
//        stop is every filtered view of a list sharing one, so switching filters serves the
//        previous filter's rows out of cache as the current answer.
//   F6 — across a filter change the previous rows STAY, and `isPlaceholderData` says they are
//        stale. Without it the list unmounts to a skeleton and repaints.
//
// So these hooks are driven. Each one is asked the same four questions, because "the console is
// one product" is exactly the claim that they all answer them the same way.
//
// The surfaces #4890 lifted (alerts × 3, access, runners) and the two #4890 lifted first (teams,
// members) are all here. The older hooks — jobs, evidence, activity, sso, roles, support,
// connectors — are not: they were already on the standard, and this file is the new work's
// instrument, not a retro-fit of coverage onto everything that predates it.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useParams: () => ({ org: "org-1" }) }));

const getAlertChannelsPage = vi.fn();
const getAlertPoliciesPage = vi.fn();
const getAlertDeliveriesPage = vi.fn();
vi.mock("@/app/server/actions/alerts", () => ({
	getAlertChannelsPage: (...a: unknown[]) => getAlertChannelsPage(...a),
	getAlertPoliciesPage: (...a: unknown[]) => getAlertPoliciesPage(...a),
	getAlertDeliveriesPage: (...a: unknown[]) => getAlertDeliveriesPage(...a),
}));

const getAccessGrantsPage = vi.fn();
vi.mock("@/app/server/actions/grants", () => ({
	getAccessGrantsPage: (...a: unknown[]) => getAccessGrantsPage(...a),
}));

const getRunnersPage = vi.fn();
vi.mock("@/app/server/actions/runners", () => ({
	getRunnersPage: (...a: unknown[]) => getRunnersPage(...a),
}));

const getTeamsPage = vi.fn();
vi.mock("@/app/server/actions/teams", () => ({
	getTeamsPage: (...a: unknown[]) => getTeamsPage(...a),
}));

const getMembersPage = vi.fn();
vi.mock("@/app/server/actions/members", () => ({
	getMembersPage: (...a: unknown[]) => getMembersPage(...a),
}));

const {
	useAlertChannelsPageQuery,
	useAlertDeliveriesPageQuery,
	useAlertPoliciesPageQuery,
} = await import("@/lib/query/use-alerts-query");
const { useAccessGrantsPageQuery } = await import(
	"@/lib/query/use-access-grants-query"
);
const { useRunnersPageQuery } = await import("@/lib/query/use-runners-page-query");
const { useTeamsPageQuery } = await import("@/lib/query/use-teams-query");
const { useMembersPageQuery } = await import("@/lib/query/use-members-query");

/** A page payload distinguishable per query, so "which answer is on screen" is observable. */
function pageFor(query: Record<string, unknown>) {
	return { rows: [{ id: JSON.stringify(query) }], resultCount: 1, total: 9, facets: {} };
}

/**
 * The part of a `UseQueryResult` these assertions read.
 *
 * Structural rather than `UseQueryResult<AlertChannelsPage | AccessGrantsPage | …>`: the seven
 * hooks return seven payload types and the two facts under test — what is on screen, and
 * whether it is stale — are the same two fields on all of them.
 */
interface PageResult {
	data: unknown;
	isPlaceholderData: boolean;
}

/**
 * One hook under test: how to call it, and the action it must reach.
 *
 * The field is `usePage` and not `render` because `react-hooks/rules-of-hooks` reads the NAME of
 * the function a hook is called from, and a lint rule that cannot see a table of hooks is a lint
 * rule doing its job.
 */
interface Subject {
	usePage: (query: Record<string, unknown>) => PageResult;
	action: ReturnType<typeof vi.fn>;
	/** The key prefix `qk` gives this resource, ahead of the query object. */
	prefix: readonly unknown[];
}

const SUBJECTS: Record<string, Subject> = {
	useAlertChannelsPageQuery: {
		usePage: (q) => useAlertChannelsPageQuery(q),
		action: getAlertChannelsPage,
		prefix: ["alerts", "channels", "org-1"],
	},
	useAlertPoliciesPageQuery: {
		usePage: (q) => useAlertPoliciesPageQuery(q),
		action: getAlertPoliciesPage,
		prefix: ["alerts", "policies", "org-1"],
	},
	useAlertDeliveriesPageQuery: {
		usePage: (q) => useAlertDeliveriesPageQuery(q),
		action: getAlertDeliveriesPage,
		prefix: ["alerts", "deliveries", "org-1"],
	},
	useAccessGrantsPageQuery: {
		usePage: (q) => useAccessGrantsPageQuery(q),
		action: getAccessGrantsPage,
		prefix: ["access", "grants", "org-1"],
	},
	useRunnersPageQuery: {
		usePage: (q) => useRunnersPageQuery(q),
		action: getRunnersPage,
		prefix: ["runners", "org-1", "page"],
	},
	useTeamsPageQuery: {
		usePage: (q) => useTeamsPageQuery(q),
		action: getTeamsPage,
		prefix: ["teams", "org-1"],
	},
	useMembersPageQuery: {
		usePage: (q) => useMembersPageQuery(q),
		action: getMembersPage,
		prefix: ["members", "org-1"],
	},
};

const ACTIONS = [
	getAlertChannelsPage,
	getAlertPoliciesPage,
	getAlertDeliveriesPage,
	getAccessGrantsPage,
	getRunnersPage,
	getTeamsPage,
	getMembersPage,
];

beforeEach(() => {
	for (const a of ACTIONS) {
		a.mockReset();
		a.mockImplementation((q: Record<string, unknown> = {}) =>
			Promise.resolve(pageFor(q)),
		);
	}
});

/** A fresh client per test — `refetchInterval: false` so the runners poll cannot race. */
function harness() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, refetchInterval: false } },
	});
	function wrapper({ children }: { children: ReactNode }) {
		return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
	}
	return { client, wrapper };
}

const PRISTINE = {};
const FILTERED = { search: "needle" };

describe.each(Object.entries(SUBJECTS))("%s", (name, subject) => {
	it("sends the normalized query to the server VERBATIM", async () => {
		const { wrapper } = harness();
		renderHook(() => subject.usePage(FILTERED), { wrapper });
		await waitFor(() => expect(subject.action).toHaveBeenCalled());
		expect(subject.action).toHaveBeenCalledWith(FILTERED);
	});

	it("puts the query IN the key — two filter states are two cache entries (F3)", async () => {
		const { client, wrapper } = harness();
		const { rerender } = renderHook((q: Record<string, unknown>) => subject.usePage(q), {
			wrapper,
			initialProps: PRISTINE,
		});
		await waitFor(() => expect(subject.action).toHaveBeenCalledTimes(1));
		rerender(FILTERED);
		await waitFor(() => expect(subject.action).toHaveBeenCalledTimes(2));

		const keys = client.getQueryCache().getAll().map((q) => q.queryKey);
		expect(keys).toHaveLength(2);
		// THE DEFECT F3 NAMES: one entry for every filtered view. Both keys carry the prefix and
		// differ only in the query object, which is what makes them two.
		for (const key of keys) {
			expect(key.slice(0, subject.prefix.length)).toEqual([...subject.prefix]);
		}
		expect(keys.map((k) => k[k.length - 1])).toEqual([PRISTINE, FILTERED]);
	});

	it("keeps the previous rows across a filter change and marks them stale (F6)", async () => {
		const { wrapper } = harness();
		// The next answer is withheld until this resolves, so the window `keepPreviousData`
		// covers is the whole of the assertion rather than a race against a resolved promise.
		let release: (() => void) | undefined;
		const { result, rerender } = renderHook(
			(q: Record<string, unknown>) => subject.usePage(q),
			{ wrapper, initialProps: PRISTINE },
		);
		await waitFor(() => expect(result.current.data).toEqual(pageFor(PRISTINE)));

		subject.action.mockImplementationOnce(
			(q: Record<string, unknown>) =>
				new Promise((resolve) => {
					release = () => resolve(pageFor(q));
				}),
		);
		rerender(FILTERED);

		// The list does NOT blank: the previous rows are still on screen…
		await waitFor(() => expect(result.current.isPlaceholderData).toBe(true));
		expect(result.current.data).toEqual(pageFor(PRISTINE));

		// …and once the server answers, they are replaced and no longer stale.
		release?.();
		await waitFor(() => expect(result.current.data).toEqual(pageFor(FILTERED)));
		expect(result.current.isPlaceholderData).toBe(false);
	});

	it("does not refetch when the query is a NEW OBJECT with the same fields", async () => {
		// The other half of "normalize": a stable SHAPE, not a stable reference. TanStack hashes
		// the key, so `{search:"needle"}` re-created each render must not re-key — otherwise
		// every keystroke after the debounce would still be a cache miss.
		const { wrapper } = harness();
		const { rerender } = renderHook((q: Record<string, unknown>) => subject.usePage(q), {
			wrapper,
			initialProps: { search: "needle" },
		});
		await waitFor(() => expect(subject.action).toHaveBeenCalledTimes(1));
		rerender({ search: "needle" });
		rerender({ search: "needle" });
		expect(subject.action).toHaveBeenCalledTimes(1);
	});
});
