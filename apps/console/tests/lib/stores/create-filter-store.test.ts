// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The per-page filter-store factory (lib/stores/create-filter-store.ts): defaults,
// set/patch/reset semantics, sessionStorage persistence (round-trip + version
// invalidation), and the active-filter counter that drives FilterBarReset.

import { beforeEach, describe, expect, it } from "vitest";
import {
	countActiveFilters,
	createFilterStore,
} from "@/lib/stores/create-filter-store";

interface TestFilters extends Record<string, unknown> {
	search: string;
	stages: string[];
	providers: string[];
}

const DEFAULTS: TestFilters = { search: "", stages: [], providers: [] };

/** A unique store per test so the module-level zustand singletons don't leak state. */
let seq = 0;
function makeStore(version = 1) {
	seq += 1;
	return createFilterStore<TestFilters>({
		name: `test-filters-${seq}`,
		defaults: DEFAULTS,
		version,
	});
}

beforeEach(() => {
	sessionStorage.clear();
});

describe("createFilterStore", () => {
	it("starts at the defaults", () => {
		const store = makeStore();
		expect(store.getState().filters).toEqual(DEFAULTS);
	});

	it("set updates a single key, patch merges several", () => {
		const store = makeStore();
		store.getState().set("search", "api");
		expect(store.getState().filters.search).toBe("api");
		expect(store.getState().filters.stages).toEqual([]);

		store.getState().patch({ stages: ["production"], providers: ["aws"] });
		const f = store.getState().filters;
		expect(f).toEqual({ search: "api", stages: ["production"], providers: ["aws"] });
	});

	it("reset restores every default", () => {
		const store = makeStore();
		store.getState().patch({ search: "x", stages: ["staging"] });
		store.getState().reset();
		expect(store.getState().filters).toEqual(DEFAULTS);
	});

	it("persists filters to sessionStorage under its name", () => {
		const store = makeStore();
		store.getState().set("providers", ["gcp", "aws"]);
		const raw = sessionStorage.getItem(`test-filters-${seq}`);
		expect(raw).not.toBeNull();
		const parsed: { state: { filters: TestFilters }; version: number } =
			JSON.parse(raw ?? "{}");
		expect(parsed.state.filters.providers).toEqual(["gcp", "aws"]);
		expect(parsed.version).toBe(1);
	});

	it("a version bump discards a previously persisted shape", () => {
		// Persist v1 state under a fixed name, then re-create the store at v2.
		const name = "test-filters-versioned";
		sessionStorage.setItem(
			name,
			JSON.stringify({
				state: { filters: { ...DEFAULTS, search: "stale" } },
				version: 1,
			}),
		);
		const store = createFilterStore<TestFilters>({
			name,
			defaults: DEFAULTS,
			version: 2,
		});
		// No migration is defined, so a version mismatch falls back to the defaults.
		expect(store.getState().filters.search).toBe("");
	});
});

describe("countActiveFilters", () => {
	it("counts only keys that differ from their defaults", () => {
		expect(countActiveFilters(DEFAULTS, DEFAULTS)).toBe(0);
		expect(
			countActiveFilters({ ...DEFAULTS, search: "api" }, DEFAULTS),
		).toBe(1);
		expect(
			countActiveFilters(
				{ search: "api", stages: ["production"], providers: ["aws"] },
				DEFAULTS,
			),
		).toBe(3);
	});

	it("treats arrays as sets (selection order is not a difference)", () => {
		const defaults: TestFilters = {
			search: "",
			stages: ["production", "staging"],
			providers: [],
		};
		expect(
			countActiveFilters(
				{ search: "", stages: ["staging", "production"], providers: [] },
				defaults,
			),
		).toBe(0);
	});
});
