// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The URL half of the filter standard (hooks/use-filter-url-sync.ts): URL-wins
// hydration on mount, non-default-only mirroring into the query string, array
// comma-codec round-trip, unrelated-param preservation, and replace-loop safety.

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// next/navigation is mocked per-test: the URL is a mutable module-level string.
let currentSearch = "";
const replace = vi.fn((url: string) => {
	currentSearch = url.includes("?") ? url.split("?")[1] : "";
});

vi.mock("next/navigation", () => ({
	useRouter: () => ({ replace }),
	usePathname: () => "/acme/~/evidence",
	useSearchParams: () => new URLSearchParams(currentSearch),
}));

import { useFilterUrlSync } from "@/hooks/use-filter-url-sync";
import { createFilterStore } from "@/lib/stores/create-filter-store";

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

beforeEach(() => {
	sessionStorage.clear();
	currentSearch = "";
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
});
