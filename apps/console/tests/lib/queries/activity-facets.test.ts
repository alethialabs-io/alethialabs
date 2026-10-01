// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Activity bar's facet pass (#5065). Before it, the User, Project and Events options carried
// no counts, so F8/F9 found no counted option to drive on either Activity route and scored them
// NOT MEASURED whatever was seeded.
//
// What is under test, and why each is a separate assertion:
//
//  1. the counts are read off the GROUPED facet rows — the API-level consequence, seeded with a
//     universe larger than the page of rows, so "counts describe the universe, rows describe the
//     query" is visible in the result rather than inferred;
//  2. the facet passes see the SCOPE — the org, and a project's own feed's pinned project — and
//     nothing the caller filtered by. `filter-standard-facets.test.ts` asserts the no-filter half
//     for every builder; this file adds the half that is particular to Activity: the pinned
//     project IS scope, so it must reach the facet passes, while the Project facet's own
//     selection must not;
//  3. "Load more" does not pay for the facets again — a later page walks the same universe.
//
// Await order, which is what the seeded result sets are handed out in: `queryActivityFacets` is
// called while the outer `Promise.all`'s argument list is being built, so ITS `Promise.all`
// awaits the actor, event and project passes before the outer one awaits the rows pass.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { mockChainDb, type RecordedChain } from "./_list-query-db";

const { getServiceDb } = vi.hoisted(() => ({ getServiceDb: vi.fn() }));
vi.mock("@/lib/db", () => ({ getServiceDb }));

import { queryActivityPage } from "@/lib/queries/activity";

const ORG = "org-1";
const PINNED = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
	vi.clearAllMocks();
});

/** Seeds the builder's await order: actor, event and project facet rows, then the page's rows. */
function seed(actors: unknown[], events: unknown[], projects: unknown[], rows: unknown[] = []) {
	const { db, chains } = mockChainDb([actors, events, projects, rows]);
	getServiceDb.mockReturnValue(db);
	return chains;
}

/** Every string leaf of a value, cycle-safe — a drizzle predicate's parameters end up several levels down. */
function leaves(value: unknown, seen = new Set<object>(), out: string[] = []): string[] {
	if (typeof value === "string") {
		out.push(value);
		return out;
	}
	if (value === null || typeof value !== "object") return out;
	if (seen.has(value)) return out;
	seen.add(value);
	for (const v of Object.values(value)) leaves(v, seen, out);
	return out;
}

/** The chains that were grouped — the facet passes. */
function facetPasses(chains: RecordedChain[]): RecordedChain[] {
	return chains.filter((c) => c.called("groupBy"));
}

/** The string leaves of one chain's WHERE. */
function whereLeaves(chain: RecordedChain): string[] {
	return leaves(chain.argsOf("where"));
}

describe("queryActivityPage — the facet counts", () => {
	it("reads each facet off the grouped rows, labelled, with both decisions always present", async () => {
		seed(
			[
				{ value: "u-1", name: "Ada", email: "ada@x.io", count: 7 },
				{ value: "u-2", name: null, email: "bob@x.io", count: 2 },
			],
			[
				{ resourceType: "project", decision: true, count: 5 },
				{ resourceType: "project", decision: false, count: 1 },
				{ resourceType: "member", decision: true, count: 3 },
			],
			[{ value: "p-1", name: "api", count: 4 }],
			// One row on the page: the counts must not be derived from it.
			[
				{
					id: 9,
					actorId: "u-1",
					actorName: "Ada",
					actorEmail: "ada@x.io",
					actorImage: null,
					actorUsername: null,
					action: "create",
					resourceType: "project",
					resourceId: "p-1",
					decision: true,
					reason: null,
					ts: new Date("2026-09-01T00:00:00.000Z"),
				},
			],
		);

		const page = await queryActivityPage(ORG, { actorIds: ["u-1"] });

		expect(page.rows).toHaveLength(1);
		expect(page.facets).toEqual({
			actors: [
				{ value: "u-1", label: "Ada", count: 7 },
				{ value: "u-2", label: "bob@x.io", count: 2 },
			],
			projects: [{ value: "p-1", label: "api", count: 4 }],
			resourceTypes: [
				{ value: "member", label: null, count: 3 },
				{ value: "project", label: null, count: 6 },
			],
			decisions: [
				{ value: "allow", label: null, count: 8 },
				{ value: "deny", label: null, count: 1 },
			],
		});
	});

	it("shows a decision nobody has at zero rather than dropping it", async () => {
		seed([], [{ resourceType: "project", decision: true, count: 2 }], []);
		const page = await queryActivityPage(ORG);
		expect(page.facets?.decisions).toEqual([
			{ value: "allow", label: null, count: 2 },
			{ value: "deny", label: null, count: 0 },
		]);
	});
});

describe("queryActivityPage — what the facet passes are given", () => {
	it("runs three grouped passes at the org scope, handed none of the caller's filters", async () => {
		const chains = seed([], [], []);
		await queryActivityPage(ORG, {
			actorIds: ["a0000000-0000-4000-8000-00000000f7a1"],
			resourceIds: ["b0000000-0000-4000-8000-00000000f7b2"],
			resourceTypes: ["needle-type"],
			search: "needle-search",
			from: "2026-09-01T00:00:00.000Z",
		});

		const facets = facetPasses(chains);
		expect(facets).toHaveLength(3);
		for (const pass of facets) {
			const where = whereLeaves(pass);
			expect(where).toContain(ORG);
			expect(where.join(" ")).not.toMatch(/f7a1|f7b2|needle/);
			// A facet pass is never windowed, paged or ordered — those belong to the rows pass.
			expect(pass.called("limit")).toBe(false);
		}
	});

	it("gives the facet passes a project feed's pinned project, and skips the Project facet there", async () => {
		const chains = seed([], [], []);
		const page = await queryActivityPage(ORG, { projectId: PINNED });

		const facets = facetPasses(chains);
		// The Project facet is hidden on a project's own feed, so its pass is not issued at all.
		expect(facets).toHaveLength(2);
		for (const pass of facets) expect(whereLeaves(pass)).toContain(PINNED);
		expect(page.facets?.projects).toEqual([]);
	});

	it("scopes the Project pass to the org's own projects through its join", async () => {
		const chains = seed([], [], []);
		await queryActivityPage(ORG);
		const projectPass = facetPasses(chains).find((c) => c.called("innerJoin"));
		expect(projectPass).toBeDefined();
		expect(leaves(projectPass?.argsOf("innerJoin"))).toContain(ORG);
	});
});

describe("queryActivityPage — later pages", () => {
	it("skips the facet passes when a cursor is set, and says so with null", async () => {
		const chains = seed([], [], []);
		const page = await queryActivityPage(ORG, { cursor: 42 });
		expect(facetPasses(chains)).toHaveLength(0);
		expect(page.facets).toBeNull();
	});
});
