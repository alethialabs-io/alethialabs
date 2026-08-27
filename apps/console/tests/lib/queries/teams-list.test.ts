// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Teams list's server half. Two things are under test and they are different in kind:
//
//  1. `teamSizeBucket` is the JS mirror of the SQL `bucketPredicate`. If the two disagree,
//     the facet says "3 small teams" and selecting `small` returns a different set — the
//     failure is silent and looks like a data problem. So the boundaries are pinned on both
//     sides of every edge.
//  2. `queryTeamsPage` must issue an UNFILTERED facet pass. The stub cannot execute SQL, so
//     that is asserted structurally — the facet chain gets exactly one WHERE argument and no
//     HAVING, and `ilike` is composed exactly once across the whole call — together with the
//     API-level consequence: seeded with a facet universe larger than the matched rows, the
//     counts describe the universe and the rows describe the query.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { mockChainDb } from "./_list-query-db";

// Spy on the real helpers so "was a search predicate built, and how many times" is observable
// without depending on the opaque identity of a drizzle SQL object.
vi.mock("drizzle-orm", async (importOriginal) => {
	const actual = await importOriginal<typeof import("drizzle-orm")>();
	return { ...actual, ilike: vi.fn(actual.ilike), or: vi.fn(actual.or) };
});

// `vi.mock` is hoisted above every `const` in this file, so the stub it closes over has to be
// created by `vi.hoisted` — a plain `const getServiceDb = vi.fn()` is in its temporal dead zone
// at mock-factory time and throws.
const { getServiceDb } = vi.hoisted(() => ({ getServiceDb: vi.fn() }));
vi.mock("@/lib/db", () => ({ getServiceDb }));

import { ilike, or } from "drizzle-orm";
import { queryTeamsPage, TEAM_SIZE_BUCKETS, teamSizeBucket } from "@/lib/queries/teams";

beforeEach(() => {
	vi.clearAllMocks();
});

describe("teamSizeBucket", () => {
	it("puts every edge on the side the SQL puts it", () => {
		// `= 0` / `between 1 and 5` / `>= 6` — the three fragments in bucketPredicate.
		expect(teamSizeBucket(0)).toBe("empty");
		expect(teamSizeBucket(1)).toBe("small");
		expect(teamSizeBucket(5)).toBe("small");
		expect(teamSizeBucket(6)).toBe("large");
		expect(teamSizeBucket(400)).toBe("large");
	});

	it("exposes exactly the three buckets the facet renders", () => {
		expect(TEAM_SIZE_BUCKETS).toEqual(["empty", "small", "large"]);
	});
});

describe("queryTeamsPage", () => {
	/** matched rows, facet rows, member rows — the builder's await order. */
	function seed(matched: unknown[], facets: unknown[], members: unknown[] = []) {
		const { db, chains } = mockChainDb([matched, facets, members]);
		getServiceDb.mockReturnValue(db);
		return chains;
	}

	it("returns matched rows, and counts facets over the WHOLE org", async () => {
		// The universe has four teams; the query matched one. Every count below must come
		// from the four, not the one — that is the invariant, stated as an outcome.
		seed(
			[{ id: "t1", name: "Platform", memberCount: 7 }],
			[
				{ teamId: "t1", memberCount: 7 },
				{ teamId: "t2", memberCount: 3 },
				{ teamId: "t3", memberCount: 0 },
				{ teamId: "t4", memberCount: 0 },
			],
			[{ teamId: "t1", userId: "u1", name: "Ada Lovelace", email: "ada@x.io" }],
		);

		const page = await queryTeamsPage("org-1", { sizes: ["large"] });

		expect(page.rows).toEqual([
			{
				id: "t1",
				name: "Platform",
				memberCount: 7,
				members: [{ userId: "u1", name: "Ada Lovelace", initials: "AD" }],
			},
		]);
		expect(page.resultCount).toBe(1);
		expect(page.total).toBe(4);
		expect(page.facets.sizes).toEqual([
			{ value: "empty", label: null, count: 2 },
			{ value: "small", label: null, count: 1 },
			{ value: "large", label: null, count: 1 },
		]);
	});

	it("keeps a zero bucket in the facet — a bucket nobody is in is still a fact", async () => {
		seed([], [{ teamId: "t1", memberCount: 2 }]);
		const page = await queryTeamsPage("org-1");
		expect(page.facets.sizes.map((o) => [o.value, o.count])).toEqual([
			["empty", 0],
			["small", 1],
			["large", 0],
		]);
	});

	it("hands the FACET pass the org predicate and nothing else", async () => {
		const chains = seed(
			[{ id: "t1", name: "Platform", memberCount: 7 }],
			[{ teamId: "t1", memberCount: 7 }],
			[],
		);

		await queryTeamsPage("org-1", { search: "plat", sizes: ["large"] });

		const [rowsPass, facetPass] = chains;
		// The rows pass composes org + search into one `and(...)`, and the size buckets into
		// a HAVING over the member-count aggregate.
		expect(rowsPass.argsOf("where")).toHaveLength(1);
		expect(rowsPass.called("having")).toBe(true);
		expect(rowsPass.argsOf("having")?.[0]).toBeDefined();
		// The facet pass gets one bare `eq(team.organizationId, …)` and no HAVING at all.
		expect(facetPass.argsOf("where")).toHaveLength(1);
		expect(facetPass.called("having")).toBe(false);
		// And the search reached SQL exactly once, so it cannot have reached both passes.
		expect(ilike).toHaveBeenCalledTimes(1);
	});

	it("builds no HAVING when no size bucket survives narrowing", async () => {
		const chains = seed([], [], []);
		await queryTeamsPage("org-1", { sizes: ["gigantic"] });
		// narrowTo returned undefined, so `having(undefined)` is passed — never `or()` of
		// nothing, which would be an empty disjunction matching no rows.
		expect(chains[0].argsOf("having")).toEqual([undefined]);
		expect(or).not.toHaveBeenCalled();
	});

	it("builds no search predicate for a whitespace-only term", async () => {
		seed([], []);
		await queryTeamsPage("org-1", { search: "   " });
		expect(ilike).not.toHaveBeenCalled();
	});

	it("skips the avatar read entirely when nothing matched", async () => {
		// The members of teams nobody asked for are not part of the answer, and the round
		// trip for them is not worth paying: the third chain must never be created.
		const chains = seed([], [{ teamId: "t1", memberCount: 1 }]);
		const page = await queryTeamsPage("org-1", { search: "nothing-matches-this" });
		expect(page.rows).toEqual([]);
		expect(chains).toHaveLength(2);
	});

	it("labels an avatar from the email when the user has no name", async () => {
		seed(
			[{ id: "t1", name: "Ops", memberCount: 1 }],
			[{ teamId: "t1", memberCount: 1 }],
			[{ teamId: "t1", userId: "u9", name: "   ", email: "nameless@x.io" }],
		);
		const page = await queryTeamsPage("org-1");
		expect(page.rows[0].members).toEqual([
			{ userId: "u9", name: "nameless@x.io", initials: "NA" },
		]);
	});

	it("gives a team with no members an empty avatar stack, not undefined", async () => {
		seed(
			[
				{ id: "t1", name: "Ops", memberCount: 1 },
				{ id: "t2", name: "Empty", memberCount: 0 },
			],
			[
				{ teamId: "t1", memberCount: 1 },
				{ teamId: "t2", memberCount: 0 },
			],
			[{ teamId: "t1", userId: "u1", name: "Ada", email: "ada@x.io" }],
		);
		const page = await queryTeamsPage("org-1");
		expect(page.rows[1].members).toEqual([]);
	});
});
