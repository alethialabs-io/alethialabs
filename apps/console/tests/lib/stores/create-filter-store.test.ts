// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The per-page filter-store factory (lib/stores/create-filter-store.ts): defaults,
// set/patch/replace/reset semantics, that a store remembers nothing unless it is built with
// `persist: true` (#6814), the opt-in sessionStorage persistence (round-trip + version
// invalidation), the scope every store has (#6730), and the active-filter counter that drives
// FilterBarReset.

import { beforeEach, describe, expect, it } from "vitest";
import {
	countActiveFilters,
	createFilterStore,
	scopedFilterKey,
} from "@/lib/stores/create-filter-store";

interface TestFilters extends Record<string, unknown> {
	search: string;
	stages: string[];
	providers: string[];
}

const DEFAULTS: TestFilters = { search: "", stages: [], providers: [] };

/** A unique store per test so the module-level zustand singletons don't leak state. */
let seq = 0;
/** A store that opted in to sessionStorage (`persist: true`). */
function makeStore(version = 1) {
	seq += 1;
	return createFilterStore<TestFilters>({
		name: `test-filters-${seq}`,
		defaults: DEFAULTS,
		version,
		persist: true,
	});
}

/** A store as the factory builds it when nothing is said about persistence. */
function makeDefaultStore() {
	seq += 1;
	return createFilterStore<TestFilters>({ name: `test-filters-${seq}`, defaults: DEFAULTS });
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

	it("replace holds exactly what it is given, keeping nothing from before", () => {
		const store = makeDefaultStore();
		store.getState().patch({ search: "api", stages: ["production"], providers: ["aws"] });
		store.getState().replace({ ...DEFAULTS, stages: ["staging"] });
		// `patch` would have kept the search and the providers.
		expect(store.getState().filters).toEqual({ search: "", stages: ["staging"], providers: [] });
	});

	it("replace with what the store already holds tells no subscriber of a change", () => {
		const store = makeDefaultStore();
		store.getState().patch({ search: "api", stages: ["production", "staging"] });
		const held = store.getState().filters;
		let notified = 0;
		const unsubscribe = store.subscribe(() => {
			notified += 1;
		});

		store.getState().replace({ search: "api", stages: ["production", "staging"], providers: [] });
		expect(notified).toBe(0);
		expect(store.getState().filters).toBe(held);

		// A different order is a different value: the URL would encode it differently.
		store.getState().replace({ search: "api", stages: ["staging", "production"], providers: [] });
		expect(notified).toBe(1);
		unsubscribe();
	});

	it("persists filters to sessionStorage under its name and scope", () => {
		const store = makeStore();
		store.getState().enterScope("/acme/~/jobs");
		store.getState().set("providers", ["gcp", "aws"]);
		expect(sessionStorage.getItem(`test-filters-${seq}`)).toBeNull();
		const raw = sessionStorage.getItem(scopedFilterKey(`test-filters-${seq}`, "/acme/~/jobs"));
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
			scopedFilterKey(name, "/acme/~/jobs"),
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
		store.getState().enterScope("/acme/~/jobs");
		// No migration is defined, so a version mismatch falls back to the defaults.
		expect(store.getState().filters.search).toBe("");
	});
});

describe("createFilterStore remembers nothing by default (#6814)", () => {
	it("says so, and a store that opted in says the opposite", () => {
		expect(makeDefaultStore().getState().remembers).toBe(false);
		expect(makeStore().getState().remembers).toBe(true);
	});

	it("writes nothing to sessionStorage in any scope", () => {
		const store = makeDefaultStore();
		store.getState().set("search", "before-any-scope");
		store.getState().enterScope("/acme/~/jobs");
		store.getState().patch({ search: "azdemo", stages: ["CANCELLED"] });
		store.getState().replace({ ...DEFAULTS, providers: ["aws"] });
		store.getState().enterScope("/acme/demo-aws-pilot/jobs");
		store.getState().set("search", "project");
		store.getState().reset();
		expect(sessionStorage.length).toBe(0);
	});

	it("reads nothing an earlier build persisted under its name", () => {
		const store = makeDefaultStore();
		const name = `test-filters-${seq}`;
		const stale = JSON.stringify({ state: { filters: { ...DEFAULTS, search: "stale" } }, version: 1 });
		sessionStorage.setItem(name, stale);
		sessionStorage.setItem(scopedFilterKey(name, "/acme/~/jobs"), stale);
		store.getState().enterScope("/acme/~/jobs");
		expect(store.getState().filters).toEqual(DEFAULTS);
	});

	it("still drops another scope's selection, and returning to a scope does not bring it back", () => {
		const store = makeDefaultStore();
		store.getState().enterScope("/acme/~/jobs");
		store.getState().set("search", "azdemo");
		store.getState().enterScope("/globex/~/jobs");
		expect(store.getState().filters).toEqual(DEFAULTS);
		store.getState().enterScope("/acme/~/jobs");
		expect(store.getState().filters).toEqual(DEFAULTS);
	});
});

describe("createFilterStore({ persist: false }) (#6320)", () => {
	it("neither rehydrates a session's selection nor writes one", () => {
		const name = "test-filters-memory-only";
		sessionStorage.setItem(name, JSON.stringify({ state: { filters: { ...DEFAULTS, search: "stale" } }, version: 1 }));
		sessionStorage.setItem(scopedFilterKey(name, "/acme/~/jobs"), JSON.stringify({ state: { filters: { ...DEFAULTS, search: "stale" } }, version: 1 }));
		const store = createFilterStore<TestFilters>({ name, defaults: DEFAULTS, persist: false });
		store.getState().enterScope("/acme/~/jobs");
		expect(store.getState().filters.search).toBe("");
		sessionStorage.clear();
		expect(store.getState().filters).toEqual(DEFAULTS);
		store.getState().set("search", "api");
		store.getState().patch({ stages: ["production"] });
		expect(store.getState().filters).toEqual({ search: "api", stages: ["production"], providers: [] });
		// Nothing persisted: the URL is the only memory, so a fresh load starts where the server did.
		expect(sessionStorage.length).toBe(0);
		store.getState().reset();
		expect(store.getState().filters).toEqual(DEFAULTS);
	});
});

describe("createFilterStore scopes what it remembers (#6730)", () => {
	const ORG_JOBS = "/acme/~/jobs";
	const PROJECT_JOBS = "/acme/demo-aws-pilot/jobs";
	const OTHER_ORG_JOBS = "/globex/~/jobs";

	it("remembers nothing before a scope is entered", () => {
		const store = makeStore();
		store.getState().set("search", "azdemo");
		expect(sessionStorage.length).toBe(0);
	});

	it("a filter set on the org page is not visible on a project page", () => {
		const store = makeStore();
		store.getState().enterScope(ORG_JOBS);
		store.getState().patch({ search: "azdemo", stages: ["CANCELLED"] });

		store.getState().enterScope(PROJECT_JOBS);
		// Neither the in-memory selection nor the persisted one crosses over.
		expect(store.getState().filters).toEqual(DEFAULTS);
		// And entering the project scope did not overwrite what the org scope remembered.
		const raw = sessionStorage.getItem(scopedFilterKey(`test-filters-${seq}`, ORG_JOBS));
		const parsed: { state: { filters: TestFilters } } = JSON.parse(raw ?? "{}");
		expect(parsed.state.filters.search).toBe("azdemo");
	});

	it("a filter set in one org is not visible in another", () => {
		const store = makeStore();
		store.getState().enterScope(ORG_JOBS);
		store.getState().set("search", "azdemo");
		store.getState().enterScope(OTHER_ORG_JOBS);
		expect(store.getState().filters.search).toBe("");
	});

	it("returning to a scope restores what that scope remembered", () => {
		const store = makeStore();
		store.getState().enterScope(ORG_JOBS);
		store.getState().set("search", "org-search");
		store.getState().enterScope(PROJECT_JOBS);
		store.getState().set("search", "project-search");

		store.getState().enterScope(ORG_JOBS);
		expect(store.getState().filters.search).toBe("org-search");
		store.getState().enterScope(PROJECT_JOBS);
		expect(store.getState().filters.search).toBe("project-search");
	});

	it("re-entering the current scope keeps the in-memory selection", () => {
		const store = makeStore();
		store.getState().enterScope(ORG_JOBS);
		store.getState().set("search", "kept");
		store.getState().enterScope(ORG_JOBS);
		expect(store.getState().filters.search).toBe("kept");
	});

	it("an in-memory-only store still drops another scope's selection", () => {
		seq += 1;
		const store = createFilterStore<TestFilters>({ name: `test-filters-${seq}`, defaults: DEFAULTS, persist: false });
		store.getState().enterScope(ORG_JOBS);
		store.getState().set("search", "azdemo");
		store.getState().enterScope(PROJECT_JOBS);
		expect(store.getState().filters.search).toBe("");
		expect(sessionStorage.length).toBe(0);
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
