// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The URL half of the filter standard (hooks/use-filter-url-sync.ts): the link REPLACES the
// store on mount and is never patched over it (#6814), the per-page scope (#6730), the one
// exception a `persist: true` store keeps, non-default-only mirroring into the query string,
// array comma-codec round-trip, unrelated-param preservation, the params a filter change
// resets, and replace-loop safety.

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// next/navigation is mocked per-test: the URL is a mutable module-level string.
let currentSearch = "";
let currentPath = "/acme/~/evidence";
const replace = vi.fn((url: string) => {
	currentSearch = url.includes("?") ? url.split("?")[1] : "";
});

vi.mock("next/navigation", () => ({
	useRouter: () => ({ replace }),
	usePathname: () => currentPath,
	useSearchParams: () => new URLSearchParams(currentSearch),
}));

import { useFilterUrlSync } from "@/hooks/use-filter-url-sync";
import { createFilterStore, scopedFilterKey } from "@/lib/stores/create-filter-store";

interface TestFilters extends Record<string, string | string[]> {
	search: string;
	stages: string[];
}

const DEFAULTS: TestFilters = { search: "", stages: [] };

let seq = 0;
/** A fresh store per test, as the factory builds it by default: the URL is its only memory. */
function makeStore() {
	seq += 1;
	return createFilterStore<TestFilters>({
		name: `url-sync-test-${seq}`,
		defaults: DEFAULTS,
	});
}

/** A fresh store that opted in to sessionStorage (unique persistence key). */
function makePersistedStore() {
	seq += 1;
	return createFilterStore<TestFilters>({
		name: `url-sync-test-${seq}`,
		defaults: DEFAULTS,
		persist: true,
	});
}

/** Plant what the current test's store persisted for one page, as an earlier visit leaves it. */
function persistFor(path: string, filters: TestFilters) {
	sessionStorage.setItem(
		scopedFilterKey(`url-sync-test-${seq}`, path),
		JSON.stringify({ state: { filters }, version: 1 }),
	);
}

beforeEach(() => {
	sessionStorage.clear();
	currentSearch = "";
	currentPath = "/acme/~/evidence";
	replace.mockClear();
});

describe("useFilterUrlSync", () => {
	it("hydrates the store from URL params on mount (URL wins over what the store held)", () => {
		const store = makeStore();
		store.getState().patch({ search: "persisted", stages: ["development"] });
		currentSearch = "search=api&stages=production,staging";

		renderHook(() => useFilterUrlSync(store, DEFAULTS));

		expect(store.getState().filters.search).toBe("api");
		expect(store.getState().filters.stages).toEqual(["production", "staging"]);
	});

	it("a bare URL is the defaults: what the store held from an earlier visit is dropped (#6814)", () => {
		// The store is a module singleton, so it outlives a client-side navigation away and back.
		const store = makeStore();
		store.getState().patch({ search: "left-behind", stages: ["development"] });

		renderHook(() => useFilterUrlSync(store, DEFAULTS));

		// The route prefetched the unfiltered page from this link; the store now asks for it too.
		expect(store.getState().filters).toEqual(DEFAULTS);
		expect(replace).not.toHaveBeenCalled();
	});

	it("a link carrying one filter is that filter over the DEFAULTS, not over the store (#6814)", () => {
		const store = makeStore();
		store.getState().patch({ search: "left-behind", stages: ["development"] });
		currentSearch = "stages=CANCELLED";

		renderHook(() => useFilterUrlSync(store, DEFAULTS));

		expect(store.getState().filters).toEqual({ search: "", stages: ["CANCELLED"] });
		expect(replace).not.toHaveBeenCalled();
	});

	it("a URL with unrelated params only is still a bare URL for the filters, and keeps them", () => {
		const store = makeStore();
		store.getState().set("search", "left-behind");
		currentSearch = "tab=report";

		renderHook(() => useFilterUrlSync(store, DEFAULTS));

		expect(store.getState().filters).toEqual(DEFAULTS);
		expect(replace).not.toHaveBeenCalled();
	});

	it("a renamed param is read under its new name", () => {
		const store = makeStore();
		store.getState().set("stages", ["development"]);
		currentSearch = "q=api";

		renderHook(() => useFilterUrlSync(store, DEFAULTS, { search: "q" }));

		expect(store.getState().filters).toEqual({ search: "api", stages: [] });
	});

	it("a default store writes nothing to sessionStorage through the hook", async () => {
		const store = makeStore();
		renderHook(() => useFilterUrlSync(store, DEFAULTS));
		act(() => store.getState().patch({ search: "api", stages: ["production"] }));
		await waitFor(() => expect(replace).toHaveBeenCalled());
		expect(sessionStorage.length).toBe(0);
	});

	it("re-reads the link when the pathname changes under a mounted page", () => {
		const store = makeStore();
		currentPath = "/acme/~/jobs";
		currentSearch = "search=azdemo";
		const { rerender } = renderHook(() => useFilterUrlSync(store, DEFAULTS));
		expect(store.getState().filters.search).toBe("azdemo");

		currentPath = "/acme/demo-aws-pilot/jobs";
		currentSearch = "stages=FAILED";
		rerender();

		expect(store.getState().filters).toEqual({ search: "", stages: ["FAILED"] });
	});

	it("mirrors non-default filters into the URL and drops defaults", async () => {
		const store = makeStore();
		renderHook(() => useFilterUrlSync(store, DEFAULTS));

		act(() => store.getState().patch({ search: "api", stages: ["production"] }));
		await waitFor(() =>
			expect(replace).toHaveBeenLastCalledWith(
				"/acme/~/evidence?search=api&stages=production",
				{ scroll: false },
			),
		);

		act(() => store.getState().reset());
		await waitFor(() =>
			expect(replace).toHaveBeenLastCalledWith("/acme/~/evidence", {
				scroll: false,
			}),
		);
	});

	it("preserves unrelated params already in the URL", async () => {
		const store = makeStore();
		currentSearch = "tab=report";
		renderHook(() => useFilterUrlSync(store, DEFAULTS));

		act(() => store.getState().set("search", "api"));
		await waitFor(() => {
			const last = replace.mock.calls.at(-1)?.[0] as string;
			const params = new URLSearchParams(last.split("?")[1]);
			expect(params.get("tab")).toBe("report");
			expect(params.get("search")).toBe("api");
		});
	});

	it("does not rewrite the URL when nothing changed", () => {
		const store = makeStore();
		currentSearch = "search=api";
		renderHook(() => useFilterUrlSync(store, DEFAULTS));
		// Hydration patched the store to match the URL — the mirror effect must
		// see an identical query string and skip router.replace.
		expect(store.getState().filters.search).toBe("api");
		expect(replace).not.toHaveBeenCalled();
	});

	it("reports the URL unread on its first render and read once the store holds it (#4980)", () => {
		// A list marks itself `aria-busy` off this value. On the first render the store still holds
		// its defaults whatever the link says, so the rows on screen answer nothing yet.
		const store = makeStore();
		currentSearch = "stages=production";
		const seen: { synced: boolean; stages: string[] }[] = [];

		const { result } = renderHook(() => {
			const synced = useFilterUrlSync(store, DEFAULTS);
			seen.push({ synced, stages: store.getState().filters.stages });
			return synced;
		});

		expect(seen[0]).toEqual({ synced: false, stages: [] });
		expect(result.current).toBe(true);
		// Never "read" over the pre-URL state: the render that says read already holds the link.
		for (const r of seen) if (r.synced) expect(r.stages).toEqual(["production"]);
	});
});

describe("useFilterUrlSync — params a filter change resets (#6814)", () => {
	const RESET = { resetParams: ["page", "selected"] };

	it("a link's page and selection survive the mount", () => {
		const store = makeStore();
		currentSearch = "stages=FAILED&page=3&selected=job-1";

		renderHook(() => useFilterUrlSync(store, DEFAULTS, undefined, RESET));

		expect(store.getState().filters.stages).toEqual(["FAILED"]);
		expect(replace).not.toHaveBeenCalled();
	});

	it("changing a filter drops them, and keeps unrelated params", async () => {
		const store = makeStore();
		currentSearch = "stages=FAILED&page=3&selected=job-1&tab=report";
		renderHook(() => useFilterUrlSync(store, DEFAULTS, undefined, RESET));

		act(() => store.getState().set("stages", ["FAILED", "CANCELLED"]));

		await waitFor(() =>
			expect(replace).toHaveBeenLastCalledWith("/acme/~/evidence?stages=FAILED%2CCANCELLED&tab=report", {
				scroll: false,
			}),
		);
	});

	it("resetting the filters drops them too", async () => {
		const store = makeStore();
		currentSearch = "stages=FAILED&page=3";
		renderHook(() => useFilterUrlSync(store, DEFAULTS, undefined, RESET));

		act(() => store.getState().reset());

		await waitFor(() => expect(replace).toHaveBeenLastCalledWith("/acme/~/evidence", { scroll: false }));
	});

	it("a write that changes no filter keeps them", async () => {
		// The only thing to write here is the removal of a retired param.
		const store = makeStore();
		currentSearch = "from=2026-10-01&page=3";
		renderHook(() =>
			useFilterUrlSync(store, DEFAULTS, undefined, { retiredParams: ["from"], resetParams: ["page"] }),
		);
		await waitFor(() => expect(replace).toHaveBeenCalledWith("/acme/~/evidence?page=3", { scroll: false }));
	});

	it("without the option a filter change leaves every other param alone", async () => {
		const store = makeStore();
		currentSearch = "page=3";
		renderHook(() => useFilterUrlSync(store, DEFAULTS));
		act(() => store.getState().set("search", "api"));
		await waitFor(() =>
			expect(replace).toHaveBeenLastCalledWith("/acme/~/evidence?page=3&search=api", { scroll: false }),
		);
	});
});

describe("useFilterUrlSync — a store that opted in to persistence (#6730)", () => {
	it("a link carrying some filter params is not merged with persisted ones", () => {
		const store = makePersistedStore();
		currentPath = "/acme/~/jobs";
		persistFor("/acme/~/jobs", { search: "azdemo", stages: [] });
		currentSearch = "stages=CANCELLED";

		renderHook(() => useFilterUrlSync(store, DEFAULTS));

		// Exactly the link's view: its one param over the defaults, no remembered search.
		expect(store.getState().filters).toEqual({ search: "", stages: ["CANCELLED"] });
		expect(replace).not.toHaveBeenCalled();
	});

	it("a bare URL restores what this page persisted", () => {
		const store = makePersistedStore();
		currentPath = "/acme/~/jobs";
		persistFor("/acme/~/jobs", { search: "azdemo", stages: [] });

		renderHook(() => useFilterUrlSync(store, DEFAULTS));

		expect(store.getState().filters.search).toBe("azdemo");
		expect(replace).toHaveBeenCalledWith("/acme/~/jobs?search=azdemo", { scroll: false });
	});

	it("a URL with unrelated params only is still a bare URL for the filters", () => {
		const store = makePersistedStore();
		currentPath = "/acme/~/jobs";
		persistFor("/acme/~/jobs", { search: "azdemo", stages: [] });
		currentSearch = "tab=report";

		renderHook(() => useFilterUrlSync(store, DEFAULTS));

		expect(store.getState().filters.search).toBe("azdemo");
	});

	it("a search set on the org page is not restored onto a project page", () => {
		const store = makePersistedStore();
		currentPath = "/acme/~/jobs";
		const org = renderHook(() => useFilterUrlSync(store, DEFAULTS));
		act(() => store.getState().set("search", "azdemo"));
		org.unmount();

		currentPath = "/acme/demo-aws-pilot/jobs";
		currentSearch = "";
		replace.mockClear();
		renderHook(() => useFilterUrlSync(store, DEFAULTS));

		expect(store.getState().filters).toEqual(DEFAULTS);
		expect(replace).not.toHaveBeenCalled();
	});

	it("a search set in one org is not restored in another", () => {
		const store = makePersistedStore();
		currentPath = "/acme/~/jobs";
		const acme = renderHook(() => useFilterUrlSync(store, DEFAULTS));
		act(() => store.getState().set("search", "azdemo"));
		acme.unmount();

		currentPath = "/globex/~/jobs";
		currentSearch = "";
		renderHook(() => useFilterUrlSync(store, DEFAULTS));

		expect(store.getState().filters.search).toBe("");
	});

	it("removes retired params on its next write, keeping unrelated ones (#6740)", async () => {
		const store = makeStore();
		currentSearch = "from=2026-10-01&to=2026-10-31&rangeLabel=Last+30+days&tab=report";
		renderHook(() => useFilterUrlSync(store, DEFAULTS, undefined, { retiredParams: ["from", "to", "rangeLabel"] }));
		await waitFor(() => expect(replace).toHaveBeenCalledWith("/acme/~/evidence?tab=report", { scroll: false }));
	});
});
