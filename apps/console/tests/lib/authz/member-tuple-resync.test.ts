// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Unit tests for the member tuple resync's ORDER and SCOPE (#5463): every member's tuples are revoked,
// then ONE backfill, then an active member's team tuples are written back. The queries themselves run
// against real Postgres in tests/integration/member-tuple-resync.test.ts; here the database answers
// from a queue, in the order the resync asks.

import { describe, expect, it, vi } from "vitest";
import type { SQL } from "drizzle-orm";
import {
	type ResyncDb,
	type ResyncTupleSync,
	resyncMemberTuples,
} from "@/lib/authz/member-tuple-resync";

/** A database whose `execute` answers each query with the next queued row set. */
function queuedDb(...answers: Record<string, unknown>[][]): ResyncDb & { queries: SQL[] } {
	const queries: SQL[] = [];
	return {
		queries,
		async execute(query: SQL) {
			queries.push(query);
			return answers.shift() ?? [];
		},
	};
}

/** A tuple sync that records every call, in order, as one line each. */
function recordingSync(): ResyncTupleSync & { calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		revokeMemberGrant: vi.fn(async (orgId: string, userId: string) => {
			calls.push(`revoke ${orgId} ${userId}`);
		}),
		backfill: vi.fn(async () => {
			calls.push("backfill");
		}),
		syncTeamMember: vi.fn(async (teamId: string, userId: string) => {
			calls.push(`team ${teamId} ${userId}`);
		}),
	};
}

describe("resyncMemberTuples", () => {
	it("revokes every member, backfills once, then writes back only ACTIVE members' team tuples", async () => {
		const db = queuedDb(
			[
				{ org_id: "org-1", user_id: "u-active", status: "active" },
				{ org_id: "org-1", user_id: "u-suspended", status: "suspended" },
			],
			[{ team_id: "team-a" }, { team_id: "team-b" }],
		);
		const sync = recordingSync();

		await expect(resyncMemberTuples(db, sync)).resolves.toEqual({ members: 2, teamTuples: 2 });
		expect(sync.calls).toEqual([
			"revoke org-1 u-active",
			"revoke org-1 u-suspended",
			"backfill",
			"team team-a u-active",
			"team team-b u-active",
		]);
		// The suspended member's teams are never even read: the members query and ONE team query.
		expect(db.queries).toHaveLength(2);
	});

	it("with no members, still backfills and writes nothing else", async () => {
		const db = queuedDb([]);
		const sync = recordingSync();

		await expect(resyncMemberTuples(db, sync, "org-1")).resolves.toEqual({ members: 0, teamTuples: 0 });
		expect(sync.calls).toEqual(["backfill"]);
	});

	it("a row whose column is not text is refused before any tuple is touched", async () => {
		const db = queuedDb([{ org_id: "org-1", user_id: null, status: "active" }]);
		const sync = recordingSync();

		await expect(resyncMemberTuples(db, sync)).rejects.toThrow(/column user_id is not text/);
		expect(sync.calls).toEqual([]);
	});

	it("a failed revoke is thrown, so the caller sees a partial run and nothing is backfilled", async () => {
		const db = queuedDb([{ org_id: "org-1", user_id: "u-1", status: "active" }]);
		const sync = recordingSync();
		vi.mocked(sync.revokeMemberGrant).mockRejectedValueOnce(new Error("openfga is down"));

		await expect(resyncMemberTuples(db, sync)).rejects.toThrow(/openfga is down/);
		expect(sync.backfill).not.toHaveBeenCalled();
	});
});
