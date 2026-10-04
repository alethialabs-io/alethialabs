// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: the #5463 OpenFGA resync after migration 0159, against real Postgres. The members and
// teams are real rows, so the SQL that picks who is resynced is what is tested; the tuple writer is a
// recording fake, because what matters here is which calls it receives and in what order:
//
//   1. every member of the named org has their tuples removed — active and suspended alike — and no
//      member of another org is touched;
//   2. one backfill runs AFTER all the removals, so it re-writes every grant row's tuples from Postgres
//      (removing after it would leave the org with no tuples at all);
//   3. team-membership tuples, which backfill does not write, are written back for ACTIVE members only.

import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { resyncMemberTuples } from "@/lib/authz/member-tuple-resync";
import type { TupleSync } from "@/lib/authz/tuple-sync";
import { getServiceDb } from "@/lib/db";
import { member, organization, team, teamMember, user } from "@/lib/db/schema";
import { describeIfDb } from "./db";

const ORG = randomUUID();
const OTHER_ORG = randomUUID();
const ACTIVE = randomUUID();
const SUSPENDED = randomUUID();
const ELSEWHERE = randomUUID();
const TEAM = randomUUID();
const USERS = [ACTIVE, SUSPENDED, ELSEWHERE];

/** A TupleSync that records each call it receives, in order. */
function recordingSync(): { sync: TupleSync; calls: string[] } {
	const calls: string[] = [];
	const sync: TupleSync = {
		async syncMemberGrant(orgId, userId, role) {
			calls.push(`syncMemberGrant ${orgId} ${userId} ${role}`);
		},
		async revokeMemberGrant(orgId, userId) {
			calls.push(`revoke ${orgId} ${userId}`);
		},
		async syncScopedGrant() {
			calls.push("syncScopedGrant");
		},
		async removeScopedGrant() {
			calls.push("removeScopedGrant");
		},
		async syncHierarchyEdge() {
			calls.push("syncHierarchyEdge");
		},
		async removeHierarchyEdge() {
			calls.push("removeHierarchyEdge");
		},
		async syncTeamMember(teamId, userId) {
			calls.push(`team ${teamId} ${userId}`);
		},
		async removeTeamMember() {
			calls.push("removeTeamMember");
		},
		async resyncRole() {
			calls.push("resyncRole");
		},
		async backfill() {
			calls.push("backfill");
		},
	};
	return { sync, calls };
}

describeIfDb("resyncMemberTuples — the OpenFGA resync 0159 could not do", () => {
	beforeAll(async () => {
		const db = getServiceDb();
		await db.insert(user).values(
			USERS.map((id) => ({ id, email: `it-resync-${id}@example.test` })),
		);
		await db.insert(organization).values([
			{ id: ORG, name: "resync", slug: `it-resync-${ORG.slice(0, 8)}` },
			{ id: OTHER_ORG, name: "resync-other", slug: `it-resync-${OTHER_ORG.slice(0, 8)}` },
		]);
		await db.insert(member).values([
			{ organizationId: ORG, userId: ACTIVE, role: "admin", status: "active" },
			{ organizationId: ORG, userId: SUSPENDED, role: "operator", status: "suspended" },
			{ organizationId: OTHER_ORG, userId: ELSEWHERE, role: "owner", status: "active" },
		]);
		await db.insert(team).values({ id: TEAM, name: "ops", organizationId: ORG });
		await db.insert(teamMember).values([
			{ teamId: TEAM, userId: ACTIVE },
			{ teamId: TEAM, userId: SUSPENDED },
		]);
	});

	afterAll(async () => {
		const db = getServiceDb();
		await db.delete(teamMember).where(eq(teamMember.teamId, TEAM));
		await db.delete(team).where(eq(team.id, TEAM));
		await db.delete(member).where(inArray(member.organizationId, [ORG, OTHER_ORG]));
		await db.delete(organization).where(inArray(organization.id, [ORG, OTHER_ORG]));
		await db.delete(user).where(inArray(user.id, USERS));
	});

	it("removes every member's tuples in the org, backfills once after, and writes team tuples back for active members only", async () => {
		const { sync, calls } = recordingSync();

		const result = await resyncMemberTuples(getServiceDb(), sync, ORG);

		const revokes = [`revoke ${ORG} ${ACTIVE}`, `revoke ${ORG} ${SUSPENDED}`].sort();
		expect(calls.slice(0, 2).sort()).toEqual(revokes);
		expect(calls.slice(2)).toEqual(["backfill", `team ${TEAM} ${ACTIVE}`]);
		expect(calls.join("\n")).not.toContain(ELSEWHERE);
		expect(result).toEqual({ members: 2, teamTuples: 1 });
	});

	it("with no org named, reaches the members of every org", async () => {
		const { sync, calls } = recordingSync();

		await resyncMemberTuples(getServiceDb(), sync);

		expect(calls).toContain(`revoke ${OTHER_ORG} ${ELSEWHERE}`);
		expect(calls).toContain(`revoke ${ORG} ${SUSPENDED}`);
		expect(calls.filter((c) => c === "backfill")).toHaveLength(1);
		expect(calls.indexOf("backfill")).toBeGreaterThan(calls.lastIndexOf(`revoke ${ORG} ${ACTIVE}`));
	});
});
