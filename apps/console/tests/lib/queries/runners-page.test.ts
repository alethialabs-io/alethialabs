// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The runners grid's server half (lib/queries/runners.ts) — the predicate, the facet pass and the
// keyset page cut behind `readRunnersPage()` (the `runners.page` read).
//
// `queryRunnersPage` is synchronous and in memory, so it is not one of the async facet-bearing
// builders `scripts/check-filter-standard.mjs` derives as F7 subjects; this file is its F7
// instrument all the same, and it asserts the invariant in the form that mechanism can carry.
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

import { decodeKeysetCursor, type KeysetPageRequest } from "@/lib/queries/keyset";
import {
	ANY_CLOUD,
	matchesRunnersQuery,
	queryRunnersPage,
	type RunnerFacts,
	runnerFacets,
	type RunnersQuery,
} from "@/lib/queries/runners";

/** A uuid whose trailing digits are `n`. */
function uuid(n: number): string {
	return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

/** A fixture runner with the instant it was created — the page's sort key. */
type KeyedRunner = RunnerFacts & { created_at: string };

let nextId = 1;

/** A runner fixture; every field the predicate and the facets read is overridable. */
function runner(over: Partial<KeyedRunner> & { name: string }): KeyedRunner {
	const n = nextId++;
	return {
		id: uuid(n),
		created_at: new Date(Date.UTC(2026, 0, 1) + n * 60_000).toISOString(),
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

/** A row's keyset position, as `readRunnersPage` hands it: `created_at`, then the id. */
const keyOf = (r: KeyedRunner) => ({ at: r.created_at, id: r.id });

/** The first page, big enough to hold every fixture row. */
const FIRST: KeysetPageRequest = { limit: 50 };

/** `queryRunnersPage` over the four fixtures, first page. */
function page(query: RunnersQuery = {}) {
	return queryRunnersPage(ALL, query, FIRST, keyOf);
}

/** `ids` of a page's rows, for readable comparisons. */
const ids = (rows: readonly { id: string }[]) => rows.map((r) => r.id);

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

describe("queryRunnersPage — the two passes `readRunnersPage` delegates to", () => {
	it("returns the matching rows newest first, and no count of any kind", () => {
		const result = page({ clouds: ["gcp"] });
		// registeredOffline was created after gcpDraining, so it comes first.
		expect(ids(result.rows)).toEqual(ids([registeredOffline, gcpDraining]));
		expect(result.nextCursor).toBeNull();
		// The list standard carries no list sizes: no result count, no total — only a boolean.
		expect(Object.keys(result).sort()).toEqual(["facets", "nextCursor", "rows", "universeEmpty"]);
		expect(result.universeEmpty).toBe(false);
	});

	it("tells first run apart from a filter that matches nothing", () => {
		expect(queryRunnersPage([], {}, FIRST, keyOf).universeEmpty).toBe(true);
		const none = page({ statuses: ["DRAINING"], clouds: ["aws"] });
		expect(none.rows).toEqual([]);
		expect(none.universeEmpty).toBe(false);
	});

	/**
	 * THE INVARIANT, and the reason this file is the instrument for the runners facet pass.
	 *
	 * Asserted against `queryRunnersPage`, which is the function the read returns — NOT against
	 * `runnerFacets(ALL)`, which would be this test re-deriving its own expected value and
	 * would go on passing if the facet pass were handed the filtered rows tomorrow.
	 *
	 * Every narrowing query is checked to have actually narrowed first. Without that control a
	 * predicate that ignored its query would satisfy the whole assertion perfectly — the trap
	 * `filter-standard-facets.test.ts` records for its own needle.
	 */
	it("offers the same options after a selection as before it", () => {
		const pristine = page().facets;
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
			const result = page(query);
			expect({ query, narrowed: result.rows.length < ALL.length }).toEqual({
				query,
				narrowed: true,
			});
			// The options a user can still pick are identical to the pristine ones, so the one
			// just picked cannot vanish from under them.
			expect({ query, facets: result.facets }).toEqual({ query, facets: pristine });
		}
	});

	it("SHRINKS when the facet pass is handed the filtered rows — the mutation this guards", () => {
		// The negative control, and it is what makes the assertion above mean anything: the
		// property "the facet set does not shrink" is only informative if a facet set CAN
		// shrink. This is `runnerFacets(result.rows)` — what `queryRunnersPage` would return if its
		// facet pass saw the query — and selecting `gcp` drops `any` out of the Cloud popover,
		// the option covering every runner that names no provider, with no way back from the bar.
		const result = page({ clouds: ["gcp"] });
		const wrong = runnerFacets(result.rows);
		expect(wrong.clouds.map((o) => o.value)).toEqual(["aws", "gcp"]);
		expect(result.facets?.clouds.map((o) => o.value)).toContain(ANY_CLOUD);
	});
});

describe("queryRunnersPage — the keyset page cut (#7484)", () => {
	/**
	 * `n` runners, THREE to a millisecond (so ties on the sort key are the common case, and a page
	 * boundary lands inside a run of ties), every fourth one on gcp. Higher n = newer.
	 */
	function fleet(n: number): KeyedRunner[] {
		return Array.from({ length: n }, (_, i) => ({
			...runner({ name: `r-${i + 1}`, supported_providers: (i + 1) % 4 === 0 ? ["gcp"] : ["aws"] }),
			id: uuid(i + 1),
			created_at: new Date(Date.UTC(2026, 0, 1) + Math.floor(i / 3)).toISOString(),
		}));
	}

	/** Walks every page of `query` at `limit`, decoding each cursor as the input schema would. */
	function walk(all: KeyedRunner[], query: RunnersQuery, limit: number) {
		const pages = [];
		let request: KeysetPageRequest = { limit };
		for (let guard = 0; guard < 1000; guard++) {
			const result = queryRunnersPage(all, query, request, keyOf);
			pages.push(result);
			if (result.nextCursor === null) break;
			const cursor = decodeKeysetCursor(result.nextCursor, "uuid");
			if (cursor === null) throw new Error("the builder minted a cursor its own codec refuses");
			request = { cursor, limit };
		}
		return pages;
	}

	it("reaches every runner exactly once across boundaries that fall inside runs of ties", () => {
		const all = fleet(25);
		// 7 does not divide 3: boundaries land after the 1st and 2nd row of a tie run.
		const pages = walk(all, {}, 7);
		expect(pages.map((p) => p.rows.length)).toEqual([7, 7, 7, 4]);
		const seen = pages.flatMap((p) => ids(p.rows));
		expect(seen).toHaveLength(25);
		expect(new Set(seen).size).toBe(25);
		// Newest first, ties broken by id descending — the total order the cursor compares against.
		expect(seen).toEqual(ids(all).reverse());
	});

	it("an exactly full last page says there is no next page, rather than costing an empty read", () => {
		const pages = walk(fleet(21), {}, 7);
		expect(pages).toHaveLength(3);
		expect(pages.at(-1)?.rows).toHaveLength(7);
		expect(pages.at(-1)?.nextCursor).toBeNull();
	});

	it("facets and universeEmpty come on the first page only, and a later page never re-counts", () => {
		const [first, second] = walk(fleet(25), {}, 10);
		expect(first?.facets?.clouds).toEqual([
			{ value: "aws", label: null, count: 19 },
			{ value: "gcp", label: null, count: 6 },
		]);
		expect(first?.universeEmpty).toBe(false);
		expect(second?.facets).toBeNull();
		expect(second?.universeEmpty).toBeNull();
	});

	it("pages the FILTERED rows, while the facets still count every runner", () => {
		const pages = walk(fleet(25), { clouds: ["gcp"] }, 4);
		const seen = pages.flatMap((p) => p.rows);
		expect(seen).toHaveLength(6);
		expect(seen.every((r) => r.supported_providers?.includes("gcp"))).toBe(true);
		expect(pages[0]?.facets?.clouds.map((o) => o.count)).toEqual([19, 6]);
	});

	it("orders by the sort key truncated to the millisecond, so a sub-ms instant cannot slip past a cursor", () => {
		// Two runners in the same millisecond, one with extra microseconds in a raw string: they tie
		// on the sort key and the id decides, exactly as `date_trunc('milliseconds', …)` would in SQL.
		const a = { ...runner({ name: "a" }), id: uuid(900), created_at: "2026-03-01T00:00:00.123456Z" };
		const b = { ...runner({ name: "b" }), id: uuid(901), created_at: "2026-03-01T00:00:00.123Z" };
		const pages = walk([a, b], {}, 1);
		expect(pages.flatMap((p) => ids(p.rows))).toEqual([b.id, a.id]);
	});
});

describe("queryRunnersPage — the org's default runner is pinned first (#7484)", () => {
	/** `n` runners, newest = highest n, with runner number `def` (an OLD one) as the default. */
	function fleetWithDefault(n: number, def: number): (KeyedRunner & { is_default: boolean })[] {
		return Array.from({ length: n }, (_, i) => ({
			...runner({ name: `d-${i + 1}`, supported_providers: (i + 1) % 2 === 0 ? ["gcp"] : ["aws"] }),
			id: uuid(1000 + i + 1),
			created_at: new Date(Date.UTC(2026, 0, 1) + (i + 1) * 1000).toISOString(),
			is_default: i + 1 === def,
		}));
	}
	const isDefault = (r: { is_default: boolean }) => r.is_default;

	/** Walks every page, decoding each cursor as the input schema would. */
	function walkPinned(all: ReturnType<typeof fleetWithDefault>, query: RunnersQuery, limit: number) {
		const pages = [];
		let request: KeysetPageRequest = { limit };
		for (let guard = 0; guard < 1000; guard++) {
			const result = queryRunnersPage(all, query, request, keyOf, isDefault);
			pages.push(result);
			if (result.nextCursor === null) break;
			const cursor = decodeKeysetCursor(result.nextCursor, "uuid");
			if (cursor === null) throw new Error("the builder minted a cursor its own codec refuses");
			request = { cursor, limit };
		}
		return pages;
	}

	it("puts the default first on page one even though it is one of the oldest runners", () => {
		const all = fleetWithDefault(12, 3);
		const [first] = walkPinned(all, {}, 5);
		expect(first?.rows[0]?.id).toBe(uuid(1003));
		// Then the walk, newest first, `limit` rows of it: the pin is outside the page size.
		expect(ids(first?.rows.slice(1) ?? [])).toEqual([12, 11, 10, 9, 8].map((n) => uuid(1000 + n)));
	});

	it("draws the default exactly once across a full walk, and every other runner once too", () => {
		const all = fleetWithDefault(12, 3);
		const seen = walkPinned(all, {}, 5).flatMap((p) => ids(p.rows));
		expect(seen.filter((id) => id === uuid(1003))).toHaveLength(1);
		expect(seen).toHaveLength(12);
		expect(new Set(seen).size).toBe(12);
		// Without the pin, the default would be walked in place, near the end.
		expect(seen.indexOf(uuid(1003))).toBe(0);
	});

	it("is not pinned when an active filter excludes it — and is not walked either", () => {
		// Runner 3 is on aws; the filter asks for gcp.
		const all = fleetWithDefault(12, 3);
		const seen = walkPinned(all, { clouds: ["gcp"] }, 4).flatMap((p) => p.rows);
		expect(seen.map((r) => r.id)).not.toContain(uuid(1003));
		expect(seen).toHaveLength(6);
		expect(seen.every((r) => r.supported_providers?.includes("gcp"))).toBe(true);
	});

	it("is pinned under a filter it matches", () => {
		const all = fleetWithDefault(12, 3);
		const [first] = walkPinned(all, { clouds: ["aws"] }, 4);
		expect(first?.rows[0]?.id).toBe(uuid(1003));
	});

	it("pins nothing when no runner is the default", () => {
		const all = fleetWithDefault(6, 0);
		const [first] = walkPinned(all, {}, 50);
		expect(ids(first?.rows ?? [])).toEqual([6, 5, 4, 3, 2, 1].map((n) => uuid(1000 + n)));
	});
});
