// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Re-derives members' OpenFGA tuples from Postgres (#5463) — the resync migration 0159 could not do.
//
// 0159 merged duplicate `member` rows and rewrote `grants` in SQL: it lowered an active pair's
// org-wide role grant and deleted every allow grant of a pair that ended up not active. The OpenFGA
// mirror is written only from the app (`getTupleSync()`), so it kept the tuples it had — more access
// than Postgres now grants — until `ensureMemberGrant` / `revokeMemberGrant` next ran for that member.
// The pairs 0159 merged are not recorded, so the safe superset is every member of every org (or of one
// org, when the operator names it).
//
// Why revoke-then-backfill and not `syncMemberGrant` per member: `syncMemberGrant` writes the tuples of
// ONE built-in role and drops every other org-wide tuple of the user, so a member who also holds a
// custom-role org-wide grant would lose it in OpenFGA while Postgres still grants it. Instead each
// member's tuples in the org are removed (`revokeMemberGrant` — org-wide, scoped and team tuples), and
// `backfill()` writes every grant row's tuples again from Postgres. `backfill()` does not write team
// membership tuples, so an ACTIVE member's are written back from `team_member`; a member who is not
// active gets none, which is what `revokeMemberGrant` leaves at suspension.
//
// Between the revokes and the backfill the members in scope have no tuples, so the OpenFGA PDP denies
// them for that interval. Run it when that is acceptable. A no-op on a community build (the tuple sync
// is the no-op writer there).

import { type SQL, sql } from "drizzle-orm";
import type { TupleSync } from "@/lib/authz/tuple-sync";

/** The one database method the resync uses: a raw query returning rows. `Db` satisfies it. */
export interface ResyncDb {
	execute(query: SQL): PromiseLike<readonly Record<string, unknown>[]>;
}

/** The tuple writes the resync makes — a subset of `TupleSync`. */
export type ResyncTupleSync = Pick<TupleSync, "revokeMemberGrant" | "backfill" | "syncTeamMember">;

/** `row[key]` when it is a string; otherwise throws, naming the column. */
function text(row: Record<string, unknown>, key: string): string {
	const value = row[key];
	if (typeof value !== "string") throw new Error(`member resync: column ${key} is not text`);
	return value;
}

/** What `resyncMemberTuples` did. */
export interface MemberResyncResult {
	/** Members whose tuples were removed and re-derived. */
	members: number;
	/** Team-membership tuples written back for active members. */
	teamTuples: number;
}

/**
 * Removes the tuples of every member (of `orgId`, or of every org) and re-writes them from Postgres:
 * `revokeMemberGrant` per member, one `backfill()`, then `syncTeamMember` for each active member's
 * teams in that org. Every step is awaited and a failure is thrown, so the caller sees a partial run.
 */
export async function resyncMemberTuples(
	db: ResyncDb,
	sync: ResyncTupleSync,
	orgId?: string,
): Promise<MemberResyncResult> {
	const orgFilter = orgId ? sql`where m.organization_id = ${orgId}::uuid` : sql``;
	const rows = await db.execute(sql`
		select m.organization_id as org_id, m.user_id, m.status
		from member m
		${orgFilter}
		order by m.organization_id, m.user_id
	`);
	const members = rows.map((r) => ({
		org_id: text(r, "org_id"),
		user_id: text(r, "user_id"),
		status: text(r, "status"),
	}));
	for (const m of members) await sync.revokeMemberGrant(m.org_id, m.user_id);
	await sync.backfill();
	let teamTuples = 0;
	for (const m of members) {
		if (m.status !== "active") continue;
		const teams = await db.execute(sql`
			select tm.team_id from team_member tm
			join team t on t.id = tm.team_id
			where tm.user_id = ${m.user_id}::uuid and t.organization_id = ${m.org_id}::uuid
		`);
		for (const t of teams) {
			await sync.syncTeamMember(text(t, "team_id"), m.user_id);
			teamTuples += 1;
		}
	}
	return { members: members.length, teamTuples };
}
