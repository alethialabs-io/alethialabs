// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The URL half of the filter standard (hooks/use-filter-url-sync.ts): the per-page scope and
// the link-replaces-session precedence on mount (#6730), non-default-only mirroring into the
// query string, array comma-codec round-trip, unrelated-param preservation, and replace-loop
// safety.

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
/** A fresh store per test (unique persistence key). */
function makeStore() {
	seq += 1;
	return createFilterStore<TestFilters>({
		name: `url-sync-test-${seq}`,
		defaults: DEFAULTS,
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
	it("hydrates the store from URL params on mount (URL wins over session state)", () => {
		const store = makeStore();
		store.getState().patch({ search: "persisted", stages: ["development"] });
		currentSearch = "search=api&stages=production,staging";

		renderHook(() => useFilterUrlSync(store, DEFAULTS));

		expect(store.getState().filters.search).toBe("api");
		expect(store.getState().filters.stages).toEqual(["production", "staging"]);
	});

	it("keeps persisted filters and reflects them into a clean URL on mount", () => {
		const store = makeStore();
		store.getState().set("search", "kept");

		renderHook(() => useFilterUrlSync(store, DEFAULTS));

		// No URL params → the store (session-persisted) wins, and the URL is
		// brought in line with it so the address bar always tells the truth.
		expect(store.getState().filters.search).toBe("kept");
		expect(replace).toHaveBeenCalledWith("/acme/~/evidence?search=kept", {
			scroll: false,
		});
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

describe("useFilterUrlSync — scope and precedence (#6730)", () => {
	it("a link carrying some filter params is not merged with persisted ones", () => {
		const store = makeStore();
		currentPath = "/acme/~/jobs";
		persistFor("/acme/~/jobs", { search: "azdemo", stages: [] });
		currentSearch = "stages=CANCELLED";

		renderHook(() => useFilterUrlSync(store, DEFAULTS));

		// Exactly the link's view: its one param over the defaults, no remembered search.
		expect(store.getState().filters).toEqual({ search: "", stages: ["CANCELLED"] });
		expect(replace).not.toHaveBeenCalled();
	});

	it("a bare URL restores what this page persisted", () => {
		const store = makeStore();
		currentPath = "/acme/~/jobs";
		persistFor("/acme/~/jobs", { search: "azdemo", stages: [] });

		renderHook(() => useFilterUrlSync(store, DEFAULTS));

		expect(store.getState().filters.search).toBe("azdemo");
		expect(replace).toHaveBeenCalledWith("/acme/~/jobs?search=azdemo", { scroll: false });
	});

	it("a URL with unrelated params only is still a bare URL for the filters", () => {
		const store = makeStore();
		currentPath = "/acme/~/jobs";
		persistFor("/acme/~/jobs", { search: "azdemo", stages: [] });
		currentSearch = "tab=report";

		renderHook(() => useFilterUrlSync(store, DEFAULTS));

		expect(store.getState().filters.search).toBe("azdemo");
	});

	it("a search set on the org page is not restored onto a project page", () => {
		const store = makeStore();
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
		const store = makeStore();
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
