// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A pasted link's FIRST client key is the one its route prefetched (#4980 review).
//
// `~/runners` and `~/alerts` prefetch the key a link describes (`runnersQueryFromUrl`,
// `alertsQueriesFromUrl`). The client reads the link into its store in an effect, and a plain
// debounced search started from the store's default `""` — so for `?search=foo&versions=1.4.0` the
// client first asked for `{versions}`, a key nobody prefetched: a real server read, and an
// unfiltered flash. These drive the REAL pipeline (the page's store, `useFilterUrlSync`, the
// debounce, the normalize step) and record every key it renders once the link has been read.

import { act, renderHook } from "@testing-library/react";
import { useMemo } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let currentSearch = "";
vi.mock("next/navigation", () => ({
	useRouter: () => ({ replace: vi.fn() }),
	usePathname: () => "/acme/~/runners",
	useSearchParams: () => new URLSearchParams(currentSearch),
}));

import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useFilterUrlSync } from "@/hooks/use-filter-url-sync";
import { DEFAULT_RUNNER_FILTERS, normalizeRunnersQuery, runnersQueryFromUrl } from "@/components/runners/runners-query";
import {
	alertsQueriesFromUrl,
	DEFAULT_POLICY_FILTERS,
	normalizePoliciesQuery,
	POLICY_URL_PARAMS,
} from "@/components/alerts/alerts-query";
import { useRunnerFilters } from "@/lib/stores/use-runner-filters";
import { useAlertPolicyFilters } from "@/lib/stores/use-alerts-filters";

beforeEach(() => {
	vi.useFakeTimers();
	sessionStorage.clear();
	useRunnerFilters.getState().reset();
	useAlertPolicyFilters.getState().reset();
});

afterEach(() => {
	vi.useRealTimers();
});

/** The runners grid's key pipeline, exactly as `runners-client.tsx` composes it. */
function useRunnersKey(): { urlRead: boolean; key: string } {
	const filters = useRunnerFilters((s) => s.filters);
	const urlRead = useFilterUrlSync(useRunnerFilters, DEFAULT_RUNNER_FILTERS);
	const search = useDebouncedValue(filters.search, 300, { urlRead });
	const key = useMemo(() => JSON.stringify(normalizeRunnersQuery(filters, search)), [filters, search]);
	return { urlRead, key };
}

/** The alerts Policies panel's key pipeline, exactly as `usePoliciesView` composes it. */
function usePoliciesKey(): { urlRead: boolean; key: string } {
	const filters = useAlertPolicyFilters((s) => s.filters);
	const urlRead = useFilterUrlSync(useAlertPolicyFilters, DEFAULT_POLICY_FILTERS, POLICY_URL_PARAMS);
	const search = useDebouncedValue(filters.search, 250, { urlRead });
	const key = useMemo(() => JSON.stringify(normalizePoliciesQuery({ ...filters, search })), [filters, search]);
	return { urlRead, key };
}

/** Every key the pipeline rendered after the link was read, oldest first. */
function keysAfterUrlRead(hook: () => { urlRead: boolean; key: string }): string[] {
	const seen: string[] = [];
	renderHook(() => {
		const out = hook();
		if (out.urlRead && seen.at(-1) !== out.key) seen.push(out.key);
		return out;
	});
	act(() => vi.advanceTimersByTime(1_000));
	return seen;
}

describe("a pasted link's first client key is the prefetched key", () => {
	it("~/runners: ?search=foo&versions=1.4.0 asks for {search, versions} first — never {versions} alone", () => {
		currentSearch = "search=foo&versions=1.4.0";
		const prefetched = JSON.stringify(runnersQueryFromUrl(new URLSearchParams(currentSearch)));
		expect(keysAfterUrlRead(useRunnersKey)).toEqual([prefetched]);
	});

	it("~/alerts policies: ?policy=x&policyStatus=off asks for {search, status} first", () => {
		currentSearch = "policy=x&policyStatus=off";
		const prefetched = JSON.stringify(alertsQueriesFromUrl(new URLSearchParams(currentSearch)).policies);
		expect(keysAfterUrlRead(usePoliciesKey)).toEqual([prefetched]);
	});
});

describe("useDebouncedValue({ urlRead })", () => {
	it("still debounces what is TYPED after the link was read", () => {
		const { result, rerender } = renderHook(({ value, read }) => useDebouncedValue(value, 250, { urlRead: read }), {
			initialProps: { value: "", read: false },
		});
		rerender({ value: "foo", read: true });
		expect(result.current, "the URL's value lands at once").toBe("foo");
		rerender({ value: "foob", read: true });
		expect(result.current, "a keystroke waits").toBe("foo");
		act(() => vi.advanceTimersByTime(250));
		expect(result.current).toBe("foob");
	});
});
