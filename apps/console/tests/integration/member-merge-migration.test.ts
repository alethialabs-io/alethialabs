// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: migration 0159's member merge (#5445) against real Postgres. The migration creates a
// unique (organization_id, user_id) index on `member`, so it first merges every pair that holds more
// than one row, least-privileged (maintainer ruling, 2026-10-03). A fresh CI database has no such pair, so applying the migration there proves nothing
// about the merge; this test seeds pairs whose rows DISAGREE on role and status and runs the
// migration's own statements on them.
//
// Everything runs in ONE transaction that is rolled back: the unique index is dropped inside it (so
// the duplicates can be seeded), and nothing outlives the test — DDL is transactional in Postgres.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { beforeAll, expect, it } from "vitest";
import { seedAuthz } from "@/lib/authz/seed";
import { BUILTIN_ROLE_IDS } from "@/lib/authz/registry";
import { getServiceDb } from "@/lib/db";
import { describeIfDb } from "./db";

/**
 * The statements of 0159 that run after its `pending_org_setups` DDL — the member merge and the
 * unique index — split on drizzle's breakpoints.
 */
function mergeStatements(): string[] {
	const file = readFileSync(
		join(__dirname, "../../lib/db/migrations/0159_ancient_lily_hollister.sql"),
		"utf8",
	);
	const anchor = file.indexOf('CREATE INDEX "pending_org_setups_user_idx"');
	if (anchor < 0) throw new Error("0159 lost its pending_org_setups_user_idx statement");
	const begin = file.indexOf("--> statement-breakpoint", anchor);
	if (begin < 0) throw new Error("0159 has nothing after its pending_org_setups DDL");
	return file
		.slice(begin + "--> statement-breakpoint".length)
		.split("--> statement-breakpoint")
		.map((s) => s.trim())
		.filter((s) => s.replace(/--[^\n]*/g, "").trim().length > 0);
}

/** Thrown to roll the transaction back once its results are read. */
class Rollback extends Error {}

/** A member row as the test reads it back. */
interface MemberRow {
	id: string;
	organization_id: string;
	role: string;
	status: string;
}

/** An org-wide user grant as the test reads it back. */
interface GrantRow {
	org_id: string;
	effect: string;
	role_id: string | null;
	permission_key: string | null;
}

/** Narrows the rows `execute` returns, so no row type is asserted into place. */
function memberRows(rows: unknown[]): MemberRow[] {
	return rows.map((r) => ({
		id: String(Reflect.get(Object(r), "id")),
		organization_id: String(Reflect.get(Object(r), "organization_id")),
		role: String(Reflect.get(Object(r), "role")),
		status: String(Reflect.get(Object(r), "status")),
	}));
}

/** Narrows grant rows; a null column stays null. */
function grantRows(rows: unknown[]): GrantRow[] {
	const text = (r: unknown, key: string): string | null => {
		const v: unknown = Reflect.get(Object(r), key);
		return v === null || v === undefined ? null : String(v);
	};
	return rows.map((r) => ({
		org_id: String(text(r, "org_id")),
		effect: String(text(r, "effect")),
		role_id: text(r, "role_id"),
		permission_key: text(r, "permission_key"),
	}));
}

describeIfDb("migration 0159 — merges differing duplicate member rows least-privileged, never refuses", () => {
	beforeAll(async () => {
		await seedAuthz(); // the built-in role rows the rewritten grants reference
	});

	it("keeps the oldest row with the lowest role and suspended-if-any, never demotes an org's only owner, only lowers grants, and creates the index", async () => {
		const USER = randomUUID();
		const OTHER_OWNER = randomUUID();
		// owner (oldest) + viewer, and another active owner exists → viewer; owner grant → viewer.
		const ORG_DEMOTE = randomUUID();
		// viewer (oldest) + owner, and no other owner → the pair keeps owner; owner grant kept.
		const ORG_SOLE_OWNER = randomUUID();
		// viewer (oldest, active) · operator (suspended) · member (active) → viewer, suspended;
		// every allow grant revoked, the deny kept.
		const ORG_SUSPENDED = randomUUID();
		// admin (oldest) + owner, another owner exists, the user's grant is viewer → admin, and the
		// viewer grant is NOT raised to admin.
		const ORG_NO_RAISE = randomUUID();
		// one owner row — untouched.
		const ORG_SINGLE = randomUUID();
		// owner,admin (oldest, SUSPENDED) + owner (active), no other owner → the kept row is an ACTIVE
		// owner (#5455 review: the owner row chosen must prefer an active one), owner grant kept.
		const ORG_SOLE_SUSPENDED = randomUUID();
		const SOLE_SUSPENDED_KEEP = randomUUID();
		const DEMOTE_KEEP = randomUUID();
		const SOLE_KEEP = randomUUID();
		const SUSPENDED_KEEP = randomUUID();
		const NO_RAISE_KEEP = randomUUID();
		const SINGLE = randomUUID();

		let outcome = "not run";
		let members: MemberRow[] = [];
		let orgGrants: GrantRow[] = [];
		let allowGrantsInSuspended = -1;
		let indexExists = false;

		await getServiceDb()
			.transaction(async (tx) => {
				await tx.execute(sql`drop index if exists "member_organization_user_unique"`);
				for (const u of [USER, OTHER_OWNER]) {
					await tx.execute(
						sql`insert into "user" (id, email) values (${u}::uuid, ${`it-merge-${u}@example.test`})`,
					);
				}
				for (const org of [ORG_DEMOTE, ORG_SOLE_OWNER, ORG_SUSPENDED, ORG_NO_RAISE, ORG_SINGLE, ORG_SOLE_SUSPENDED]) {
					await tx.execute(
						sql`insert into organization (id, name, slug) values (${org}::uuid, 'merge', ${`it-merge-${org.slice(0, 8)}`})`,
					);
				}
				await tx.execute(sql`
					insert into member (id, organization_id, user_id, role, status, created_at) values
					  (${DEMOTE_KEEP}::uuid, ${ORG_DEMOTE}::uuid, ${USER}::uuid, 'owner', 'active', '2026-01-01'),
					  (gen_random_uuid(), ${ORG_DEMOTE}::uuid, ${USER}::uuid, 'viewer', 'active', '2026-02-01'),
					  (gen_random_uuid(), ${ORG_DEMOTE}::uuid, ${OTHER_OWNER}::uuid, 'owner', 'active', '2026-01-01'),
					  (${SOLE_KEEP}::uuid, ${ORG_SOLE_OWNER}::uuid, ${USER}::uuid, 'viewer', 'active', '2026-01-01'),
					  (gen_random_uuid(), ${ORG_SOLE_OWNER}::uuid, ${USER}::uuid, 'owner', 'active', '2026-02-01'),
					  (${SUSPENDED_KEEP}::uuid, ${ORG_SUSPENDED}::uuid, ${USER}::uuid, 'viewer', 'active', '2026-01-01'),
					  (gen_random_uuid(), ${ORG_SUSPENDED}::uuid, ${USER}::uuid, 'operator', 'suspended', '2026-02-01'),
					  (gen_random_uuid(), ${ORG_SUSPENDED}::uuid, ${USER}::uuid, 'member', 'active', '2026-03-01'),
					  (gen_random_uuid(), ${ORG_SUSPENDED}::uuid, ${OTHER_OWNER}::uuid, 'owner', 'active', '2026-01-01'),
					  (${NO_RAISE_KEEP}::uuid, ${ORG_NO_RAISE}::uuid, ${USER}::uuid, 'admin,viewer', 'active', '2026-01-01'),
					  (gen_random_uuid(), ${ORG_NO_RAISE}::uuid, ${USER}::uuid, 'owner', 'active', '2026-02-01'),
					  (gen_random_uuid(), ${ORG_NO_RAISE}::uuid, ${OTHER_OWNER}::uuid, 'owner', 'active', '2026-01-01'),
					  (${SINGLE}::uuid, ${ORG_SINGLE}::uuid, ${USER}::uuid, 'owner', 'active', '2026-01-01'),
					  (${SOLE_SUSPENDED_KEEP}::uuid, ${ORG_SOLE_SUSPENDED}::uuid, ${USER}::uuid, 'owner,admin', 'suspended', '2026-01-01'),
					  (gen_random_uuid(), ${ORG_SOLE_SUSPENDED}::uuid, ${USER}::uuid, 'owner', 'active', '2026-02-01')`);
				// The org-wide role grants each pair's lifecycle wrote, a scoped allow and an org-wide deny.
				await tx.execute(sql`
					insert into grants (org_id, principal_type, principal_id, role_id, resource_type) values
					  (${ORG_DEMOTE}::uuid, 'user', ${USER}::uuid, ${BUILTIN_ROLE_IDS.owner}::uuid, 'org'),
					  (${ORG_SOLE_OWNER}::uuid, 'user', ${USER}::uuid, ${BUILTIN_ROLE_IDS.owner}::uuid, 'org'),
					  (${ORG_SUSPENDED}::uuid, 'user', ${USER}::uuid, ${BUILTIN_ROLE_IDS.viewer}::uuid, 'org'),
					  (${ORG_NO_RAISE}::uuid, 'user', ${USER}::uuid, ${BUILTIN_ROLE_IDS.viewer}::uuid, 'org'),
					  (${ORG_SOLE_SUSPENDED}::uuid, 'user', ${USER}::uuid, ${BUILTIN_ROLE_IDS.owner}::uuid, 'org')`);
				await tx.execute(sql`
					insert into grants (org_id, principal_type, principal_id, role_id, resource_type, resource_id)
					values (${ORG_SUSPENDED}::uuid, 'user', ${USER}::uuid, ${BUILTIN_ROLE_IDS.operator}::uuid, 'project', gen_random_uuid())`);
				await tx.execute(sql`
					insert into grants (org_id, principal_type, principal_id, effect, permission_key, resource_type)
					select ${ORG_SUSPENDED}::uuid, 'user', ${USER}::uuid, 'deny', key, 'org' from permission limit 1`);

				try {
					for (const statement of mergeStatements()) await tx.execute(sql.raw(statement));
					outcome = "ok";
				} catch (e) {
					outcome = e instanceof Error ? e.message : String(e);
				}
				if (outcome === "ok") {
					members = memberRows(
						await tx.execute(sql`
							select id, organization_id, role, status from member
							 where user_id = ${USER}::uuid order by organization_id, id`),
					);
					orgGrants = grantRows(
						await tx.execute(sql`
							select org_id, effect, role_id, permission_key from grants
							 where principal_id = ${USER}::uuid and resource_type = 'org' and resource_id is null
							 order by org_id, effect, role_id`),
					);
					allowGrantsInSuspended = (
						await tx.execute(sql`
							select 1 from grants
							 where principal_id = ${USER}::uuid and org_id = ${ORG_SUSPENDED}::uuid and effect = 'allow'`)
					).length;
					indexExists =
						(
							await tx.execute(
								sql`select 1 from pg_indexes where indexname = 'member_organization_user_unique'`,
							)
						).length === 1;
				}
				throw new Rollback("read; roll back");
			})
			.catch((e: unknown) => {
				if (!(e instanceof Rollback)) throw e;
			});

		expect(outcome).toBe("ok");
		const byOrg = new Map(members.map((m) => [m.organization_id, m]));
		expect(members).toHaveLength(6);
		expect(byOrg.get(ORG_DEMOTE)).toEqual({
			id: DEMOTE_KEEP,
			organization_id: ORG_DEMOTE,
			role: "viewer",
			status: "active",
		});
		expect(byOrg.get(ORG_SOLE_OWNER)).toEqual({
			id: SOLE_KEEP,
			organization_id: ORG_SOLE_OWNER,
			role: "owner",
			status: "active",
		});
		expect(byOrg.get(ORG_SUSPENDED)).toEqual({
			id: SUSPENDED_KEEP,
			organization_id: ORG_SUSPENDED,
			role: "viewer",
			status: "suspended",
		});
		expect(byOrg.get(ORG_NO_RAISE)).toEqual({
			id: NO_RAISE_KEEP,
			organization_id: ORG_NO_RAISE,
			role: "admin,viewer",
			status: "active",
		});
		expect(byOrg.get(ORG_SINGLE)).toEqual({
			id: SINGLE,
			organization_id: ORG_SINGLE,
			role: "owner",
			status: "active",
		});

		// The org's only owner had a suspended and an active owner row: it stays an ACTIVE owner.
		expect(byOrg.get(ORG_SOLE_SUSPENDED)).toEqual({
			id: SOLE_SUSPENDED_KEEP,
			organization_id: ORG_SOLE_SUSPENDED,
			role: "owner",
			status: "active",
		});

		/** The org-wide allow role grants left for one org. */
		const roleGrants = (org: string) =>
			orgGrants.filter((g) => g.org_id === org && g.effect === "allow" && g.role_id !== null);
		// Lowered: the owner grant is replaced by the merged viewer role.
		expect(roleGrants(ORG_DEMOTE)).toEqual([
			{ org_id: ORG_DEMOTE, effect: "allow", role_id: BUILTIN_ROLE_IDS.viewer, permission_key: null },
		]);
		// The org's only owner keeps owner, and so keeps the owner grant.
		expect(roleGrants(ORG_SOLE_OWNER)).toEqual([
			{ org_id: ORG_SOLE_OWNER, effect: "allow", role_id: BUILTIN_ROLE_IDS.owner, permission_key: null },
		]);
		expect(roleGrants(ORG_SOLE_SUSPENDED)).toEqual([
			{ org_id: ORG_SOLE_SUSPENDED, effect: "allow", role_id: BUILTIN_ROLE_IDS.owner, permission_key: null },
		]);
		// Never raised: the viewer grant stays viewer although the merged role is admin.
		expect(roleGrants(ORG_NO_RAISE)).toEqual([
			{ org_id: ORG_NO_RAISE, effect: "allow", role_id: BUILTIN_ROLE_IDS.viewer, permission_key: null },
		]);
		// A suspended merge revokes every allow grant (org-wide and scoped) and keeps the deny.
		expect(allowGrantsInSuspended).toBe(0);
		expect(orgGrants.filter((g) => g.org_id === ORG_SUSPENDED && g.effect === "deny")).toHaveLength(1);
		expect(indexExists).toBe(true);
	});
});
