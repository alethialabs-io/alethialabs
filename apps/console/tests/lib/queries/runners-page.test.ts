// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The runners grid's server half (lib/queries/runners.ts) — the predicate and the facet pass
// behind `getRunnersPage()`.
//
// This file is the instrument `scripts/check-filter-standard.mjs`'s `F7_UNDRIVEN` names for
// `getRunnersPage`, and it asserts the invariant in the form that mechanism can carry.
// `filter-standard-facets.test.ts` drives the SQL builders by recording what the SECOND drizzle
// chain was handed; a runner's universe is a COMPOSITION of an RLS read and a service read, so
// there is no second chain to inspect. What there is instead is two functions over one array,
// and the property is the one `queryProjects` — the other in-memory builder — is declared
// against: THE FACET SET MUST NOT SHRINK AS THE QUERY NARROWS.
//
// Why that property and not "the counts are right": a facet tallied over the filtered rows also
// produces right-looking counts. What it cannot do is keep offering the option you just
// un-selected, which is what makes a filter bar un-un-selectable — so the assertion is about
// what survives narrowing, and the narrowing it survives is checked to have actually narrowed.

import { describe, expect, it } from "vitest";

import {
	ANY_CLOUD,
	matchesRunnersQuery,
	type RunnerFacts,
	runnerFacets,
	runnersPage,
	type RunnersQuery,
} from "@/lib/queries/runners";

/** A runner fixture; every field the predicate and the facets read is overridable. */
function runner(over: Partial<RunnerFacts> & { name: string }): RunnerFacts {
	return {
		status: "ONLINE",
		operator: "self",
		provisioning: "deployed",
		supported_providers: ["aws"],
		location: "eu-central-1",
		version: "1.0.0",
		runner_releases: null,
		...over,
	};
}

const awsOnline = runner({ name: "aws-prod" });
const gcpDraining = runner({
	name: "gcp-batch",
	status: "DRAINING",
	supported_providers: ["gcp"],
	location: "europe-west1",
	version: "1.1.0",
});
const managedPinned = runner({
	name: "managed-pool-1",
	operator: "managed",
	provisioning: null,
	supported_providers: null,
	location: "eu-central-1",
	version: "0.9.0",
	runner_releases: { version: "2.0.0" },
});
const registeredOffline = runner({
	name: "bare-metal",
	status: null,
	provisioning: "registered",
	supported_providers: ["aws", "gcp"],
	location: null,
	version: null,
});

const ALL = [awsOnline, gcpDraining, managedPinned, registeredOffline];

/** The rows a query selects — the action's first pass, spelled out. */
function rowsFor(query: RunnersQuery): RunnerFacts[] {
	return ALL.filter((r) => matchesRunnersQuery(r, query));
}

describe("matchesRunnersQuery", () => {
	it("selects every runner for an empty query", () => {
		expect(rowsFor({})).toEqual(ALL);
	});

	it("reads a null status as OFFLINE rather than as 'no status'", () => {
		expect(rowsFor({ statuses: ["OFFLINE"] })).toEqual([registeredOffline]);
		expect(rowsFor({ statuses: ["DRAINING"] })).toEqual([gcpDraining]);
	});

	it("buckets a managed runner by operator and everything else by provisioning", () => {
		expect(rowsFor({ operators: ["managed"] })).toEqual([managedPinned]);
		expect(rowsFor({ operators: ["registered"] })).toEqual([registeredOffline]);
		expect(rowsFor({ operators: ["deployed"] })).toEqual([awsOnline, gcpDraining]);
	});

	it("puts a runner naming no provider under `any`, not under all of them", () => {
		expect(rowsFor({ clouds: [ANY_CLOUD] })).toEqual([managedPinned]);
		expect(rowsFor({ clouds: ["aws"] })).toEqual([awsOnline, registeredOffline]);
	});

	it("keeps a runner matching ANY selected cloud (a union, not an intersection)", () => {
		expect(rowsFor({ clouds: ["aws", "gcp"] })).toEqual([
			awsOnline,
			gcpDraining,
			registeredOffline,
		]);
	});

	it("prefers the pinned release over the runner's own recorded version", () => {
		expect(rowsFor({ versions: ["2.0.0"] })).toEqual([managedPinned]);
		// 0.9.0 is what `managedPinned.version` says, and it is NOT what that runner reports.
		expect(rowsFor({ versions: ["0.9.0"] })).toEqual([]);
	});

	it("drops a runner with no location from any region selection", () => {
		expect(rowsFor({ regions: ["eu-central-1"] })).toEqual([awsOnline, managedPinned]);
	});

	it("matches the search case-insensitively against the name", () => {
		expect(rowsFor({ search: "AWS" })).toEqual([awsOnline]);
	});

	it("intersects the dimensions", () => {
		expect(rowsFor({ clouds: ["aws"], statuses: ["ONLINE"] })).toEqual([awsOnline]);
	});
});

describe("runnerFacets counts the UNFILTERED universe", () => {
	it("counts a multi-provider runner once per provider", () => {
		const clouds = runnerFacets(ALL).clouds;
		expect(clouds).toEqual([
			{ value: ANY_CLOUD, label: null, count: 1 },
			{ value: "aws", label: null, count: 2 },
			{ value: "gcp", label: null, count: 2 },
		]);
	});

	it("omits a dimension no runner has, so the bar never offers a dead option", () => {
		// `registeredOffline` has no location and no version at all.
		expect(runnerFacets([registeredOffline])).toEqual({
			clouds: [
				{ value: "aws", label: null, count: 1 },
				{ value: "gcp", label: null, count: 1 },
			],
			regions: [],
			versions: [],
		});
	});

	it("orders versions newest-first and regions alphabetically", () => {
		const { regions, versions } = runnerFacets(ALL);
		expect(regions.map((o) => o.value)).toEqual(["eu-central-1", "europe-west1"]);
		expect(versions.map((o) => o.value)).toEqual(["2.0.0", "1.1.0", "1.0.0"]);
	});

});

describe("runnersPage — the two passes `getRunnersPage` delegates to", () => {
	it("reports the result count and the universe size separately", () => {
		const page = runnersPage(ALL, { clouds: ["gcp"] });
		expect(page.rows).toEqual([gcpDraining, registeredOffline]);
		expect(page.resultCount).toBe(2);
		// `total` is what tells "no runners yet" apart from "none match these filters".
		expect(page.total).toBe(ALL.length);
	});

	/**
	 * THE INVARIANT, and the reason this file is the instrument for the runners facet pass.
	 *
	 * Asserted against `runnersPage`, which is the function the action returns — NOT against
	 * `runnerFacets(ALL)`, which would be this test re-deriving its own expected value and
	 * would go on passing if the facet pass were handed the filtered rows tomorrow.
	 *
	 * Every narrowing query is checked to have actually narrowed first. Without that control a
	 * predicate that ignored its query would satisfy the whole assertion perfectly — the trap
	 * `filter-standard-facets.test.ts` records for its own needle.
	 */
	it("offers the same options after a selection as before it", () => {
		const pristine = runnersPage(ALL).facets;
		const narrowing: RunnersQuery[] = [
			{ clouds: ["aws"] },
			{ regions: ["eu-central-1"] },
			{ versions: ["2.0.0"] },
			{ statuses: ["ONLINE"] },
			{ operators: ["managed"] },
			{ search: "aws" },
			{ clouds: ["gcp"], statuses: ["DRAINING"] },
		];
		// Both assertions carry the query in the COMPARED value rather than in a message
		// argument, so a failure names the query that broke it. `expect(v, "msg")` is real
		// vitest and is what this wants to say; `vitest/valid-expect` refuses it.
		for (const query of narrowing) {
			const page = runnersPage(ALL, query);
			expect({ query, narrowed: page.rows.length < ALL.length }).toEqual({
				query,
				narrowed: true,
			});
			// The options a user can still pick are identical to the pristine ones, so the one
			// just picked cannot vanish from under them.
			expect({ query, facets: page.facets }).toEqual({ query, facets: pristine });
		}
	});

	it("SHRINKS when the facet pass is handed the filtered rows — the mutation this guards", () => {
		// The negative control, and it is what makes the assertion above mean anything: the
		// property "the facet set does not shrink" is only informative if a facet set CAN
		// shrink. This is `runnerFacets(page.rows)` — what `runnersPage` would return if its
		// facet pass saw the query — and selecting `gcp` drops `any` out of the Cloud popover,
		// the option covering every runner that names no provider, with no way back from the bar.
		const page = runnersPage(ALL, { clouds: ["gcp"] });
		const wrong = runnerFacets(page.rows);
		expect(wrong.clouds.map((o) => o.value)).toEqual(["aws", "gcp"]);
		expect(page.facets.clouds.map((o) => o.value)).toContain(ANY_CLOUD);
	});
});
