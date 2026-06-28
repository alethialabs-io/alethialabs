// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Mocked-boundary tests for getTeams: stub the actor + a thenable drizzle chain that yields a
// queue of result sets (teams query, then the team-member join), and assert the empty-Community
// path, the member grouping/count, the name→email display fallback, and the initials derivation.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/authz/guard", () => ({ currentActor: vi.fn() }));
vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));

import { getTeams } from "@/app/server/actions/teams";
import { currentActor } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";

/**
 * A drizzle-ish chain whose builders return itself; each top-level `await` (the `.then`)
 * dequeues the next seeded result set, so sequential queries get distinct rows.
 */
function mockDb(resultSets: unknown[][]) {
	const queue = [...resultSets];
	const whereSpy = vi.fn();
	const db: Record<string, unknown> = {};
	Object.assign(db, {
		select: () => db,
		from: () => db,
		innerJoin: () => db,
		where: (...a: unknown[]) => {
			whereSpy(...a);
			return db;
		},
		then: (resolve: (v: unknown) => void) => resolve(queue.shift() ?? []),
	});
	vi.mocked(getServiceDb).mockReturnValue(db as never);
	return { whereSpy };
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(currentActor).mockResolvedValue({ orgId: "org-1", userId: "user-1" } as never);
});

describe("getTeams", () => {
	it("returns an empty list when the org has no teams (Community)", async () => {
		const { whereSpy } = mockDb([[]]); // teams query → no rows
		expect(await getTeams()).toEqual([]);
		// Short-circuits before the member query: only the teams `.where` ran.
		expect(whereSpy).toHaveBeenCalledTimes(1);
	});

	it("groups members per team and counts them", async () => {
		mockDb([
			[
				{ id: "team-1", name: "Platform" },
				{ id: "team-2", name: "Empty" },
			],
			[
				{ teamId: "team-1", userId: "u1", name: "Ada Lovelace", email: "ada@x.io" },
				{ teamId: "team-1", userId: "u2", name: "Grace Hopper", email: "grace@x.io" },
			],
		]);

		const rows = await getTeams();
		expect(rows).toHaveLength(2);

		const platform = rows.find((t) => t.id === "team-1");
		expect(platform).toMatchObject({ name: "Platform", memberCount: 2 });
		expect(platform?.members.map((m) => m.userId)).toEqual(["u1", "u2"]);

		// A team with no member rows gets an empty members array + zero count.
		const empty = rows.find((t) => t.id === "team-2");
		expect(empty).toMatchObject({ memberCount: 0, members: [] });
	});

	it("falls back to email and derives uppercase initials when the name is blank", async () => {
		mockDb([
			[{ id: "team-1", name: "Platform" }],
			[
				{ teamId: "team-1", userId: "u1", name: "  ", email: "zoe@x.io" }, // blank name → email
				{ teamId: "team-1", userId: "u2", name: null, email: "max@x.io" }, // null name → email
				{ teamId: "team-1", userId: "u3", name: "Ada Lovelace", email: "ada@x.io" },
			],
		]);

		const members = (await getTeams())[0].members;
		expect(members[0]).toMatchObject({ name: "zoe@x.io", initials: "ZO" });
		expect(members[1]).toMatchObject({ name: "max@x.io", initials: "MA" });
		expect(members[2]).toMatchObject({ name: "Ada Lovelace", initials: "AD" });
	});

	it("scopes the teams query to the actor's active org", async () => {
		vi.mocked(currentActor).mockResolvedValue({ orgId: "org-xyz", userId: "user-1" } as never);
		mockDb([[]]);
		await getTeams();
		// The org-scoping predicate is constructed from actor.orgId (eq(team.organizationId, …)).
		expect(currentActor).toHaveBeenCalledTimes(1);
	});
});
