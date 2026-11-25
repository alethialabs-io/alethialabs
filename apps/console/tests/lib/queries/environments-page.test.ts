// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Environments list's server half (lib/queries/environments.ts) — the predicate, the facet
// pass and the in-memory keyset pager behind the `environments.page` read (LST-3 #7485).
//
// The list is narrowed in memory over the project's environments (the read composes them, and
// every other part of the page needs all of them), so the standard's invariant is asserted in the
// form that mechanism can carry: THE FACET SET DOES NOT SHRINK AS THE QUERY NARROWS. Each narrowing
// is first checked to have actually narrowed.

import { describe, expect, it } from "vitest";
import {
	type EnvironmentFacts,
	type EnvironmentsQuery,
	matchesEnvironmentsQuery,
	queryEnvironmentsPage,
} from "@/lib/queries/environments";
import { decodeKeysetCursor } from "@/lib/queries/keyset";

/** The first page, every row of it, with its facets asserted present. */
function environmentsPage(all: EnvironmentFacts[], query: EnvironmentsQuery = {}) {
	const page = queryEnvironmentsPage(all, query, { limit: 100 });
	if (page.facets === null) throw new Error("the first page carries facets");
	return { ...page, facets: page.facets, rowIds: page.rows.map((r) => r.id) };
}

const dev: EnvironmentFacts = {
	id: "00000000-0000-4000-8000-000000000003",
	name: "development",
	stage: "development",
	status: "ACTIVE",
	created_at: "2026-10-03T00:00:00.000Z",
};
const qa: EnvironmentFacts = {
	id: "00000000-0000-4000-8000-000000000002",
	name: "qa",
	stage: "development",
	status: "FAILED",
	created_at: "2026-10-02T00:00:00.000Z",
};
const staging: EnvironmentFacts = {
	id: "00000000-0000-4000-8000-000000000001",
	name: "staging",
	stage: "staging",
	status: "DRAFT",
	created_at: "2026-10-01T00:00:00.000Z",
};
const ALL = [dev, qa, staging];

describe("matchesEnvironmentsQuery", () => {
	it("an empty query matches every environment", () => {
		expect(ALL.every((env) => matchesEnvironmentsQuery(env, {}))).toBe(true);
	});

	it("search is a case-insensitive contains-match on the name", () => {
		expect(ALL.filter((env) => matchesEnvironmentsQuery(env, { search: "STAG" }))).toEqual([staging]);
	});

	it("stage and status combine", () => {
		expect(ALL.filter((env) => matchesEnvironmentsQuery(env, { stages: ["development"] }))).toEqual([dev, qa]);
		expect(
			ALL.filter((env) => matchesEnvironmentsQuery(env, { stages: ["development"], statuses: ["FAILED"] })),
		).toEqual([qa]);
		expect(ALL.filter((env) => matchesEnvironmentsQuery(env, { stages: ["staging"], statuses: ["FAILED"] }))).toEqual([]);
	});
});

describe("environmentsPage — the two passes", () => {
	const narrowing: EnvironmentsQuery[] = [
		{ search: "qa" },
		{ stages: ["staging"] },
		{ statuses: ["FAILED"] },
		{ stages: ["development"], statuses: ["ACTIVE"] },
		{ search: "matches-nothing-at-all" },
	];

	it.each(narrowing)("the facet options do not shrink under %o", (query) => {
		const pristine = environmentsPage(ALL);
		const narrowed = environmentsPage(ALL, query);
		// The query did narrow the rows — otherwise the comparison below proves nothing.
		expect(narrowed.rowIds.length).toBeLessThan(pristine.rowIds.length);
		expect(narrowed.facets).toEqual(pristine.facets);
		expect(narrowed.universeEmpty).toBe(false);
	});

	it("offers the three stages always, in promotion order, and only the statuses that exist", () => {
		const { facets } = environmentsPage(ALL);
		expect(facets.stages).toEqual([
			{ value: "development", label: null, count: 2 },
			{ value: "staging", label: null, count: 1 },
			{ value: "production", label: null, count: 0 },
		]);
		expect(facets.statuses.map((o: { value: string }) => o.value).sort()).toEqual(["ACTIVE", "DRAFT", "FAILED"]);
	});

	it("returns the matching environments newest first", () => {
		expect(environmentsPage(ALL).rowIds).toEqual([dev.id, qa.id, staging.id]);
		expect(environmentsPage(ALL, { stages: ["development"] }).rowIds).toEqual([dev.id, qa.id]);
	});

	it("a project with no environment is `universeEmpty` — not `no match`, and no count", () => {
		const page = environmentsPage([], { search: "x" });
		expect(page).toMatchObject({ rowIds: [], universeEmpty: true, nextCursor: null });
		expect(page).not.toHaveProperty("total");
	});
});

describe("queryEnvironmentsPage — keyset paging in memory (LST-3 #7485)", () => {
	/** `n` environments, two to a millisecond, so boundaries fall between tied rows. */
	function many(n: number): EnvironmentFacts[] {
		return Array.from({ length: n }, (_, i) => ({
			id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
			name: `env-${i}`,
			stage: "development",
			status: "ACTIVE",
			created_at: new Date(Date.UTC(2026, 0, 1) + Math.floor(i / 2)).toISOString(),
		}));
	}

	it("walks every environment exactly once across pages, facets on the first page only", () => {
		const all = many(11);
		const seen: string[] = [];
		let cursor = undefined as ReturnType<typeof decodeKeysetCursor> | undefined;
		for (let n = 0; n < 20; n++) {
			const page = queryEnvironmentsPage(all, {}, { cursor: cursor ?? undefined, limit: 3 });
			expect(page.facets === null).toBe(n > 0);
			seen.push(...page.rows.map((r) => r.id));
			if (page.nextCursor === null) break;
			cursor = decodeKeysetCursor(page.nextCursor);
		}
		expect(seen).toHaveLength(11);
		expect(new Set(seen).size).toBe(11);
		expect(seen).toEqual([...seen].sort().reverse());
	});
});
