// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Environments list's server half (lib/queries/environments.ts) — the predicate and the facet
// pass behind the `environments.overview` read's `page`.
//
// The list is narrowed in memory over the project's environments (the read composes them, and
// every other part of the page needs all of them), so the standard's invariant is asserted in the
// form that mechanism can carry: THE FACET SET DOES NOT SHRINK AS THE QUERY NARROWS. Each narrowing
// is first checked to have actually narrowed.

import { describe, expect, it } from "vitest";
import {
	type EnvironmentFacts,
	type EnvironmentsQuery,
	environmentsPage,
	matchesEnvironmentsQuery,
} from "@/lib/queries/environments";

const dev: EnvironmentFacts = { id: "e-dev", name: "development", stage: "development", status: "ACTIVE" };
const qa: EnvironmentFacts = { id: "e-qa", name: "qa", stage: "development", status: "FAILED" };
const staging: EnvironmentFacts = { id: "e-stg", name: "staging", stage: "staging", status: "DRAFT" };
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
		expect(narrowed.total).toBe(3);
		expect(narrowed.resultCount).toBe(narrowed.rowIds.length);
	});

	it("offers the three stages always, in promotion order, and only the statuses that exist", () => {
		const { facets } = environmentsPage(ALL);
		expect(facets.stages).toEqual([
			{ value: "development", label: null, count: 2 },
			{ value: "staging", label: null, count: 1 },
			{ value: "production", label: null, count: 0 },
		]);
		expect(facets.statuses.map((o) => o.value).sort()).toEqual(["ACTIVE", "DRAFT", "FAILED"]);
	});

	it("returns the matching ids in the list's order", () => {
		expect(environmentsPage(ALL).rowIds).toEqual(["e-dev", "e-qa", "e-stg"]);
		expect(environmentsPage(ALL, { stages: ["development"] }).rowIds).toEqual(["e-dev", "e-qa"]);
	});

	it("a project with no environment is `total` 0 — not `no match`", () => {
		expect(environmentsPage([], { search: "x" })).toMatchObject({ rowIds: [], resultCount: 0, total: 0 });
	});
});
