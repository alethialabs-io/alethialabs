// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: migration 0159's member merge (#5445) against real Postgres. The migration creates a
// unique (organization_id, user_id) index on `member`, so it first merges every pair that holds more
// than one row. A fresh CI database has no such pair, so applying the migration there proves nothing
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

describeIfDb("migration 0159 — merges differing duplicate member rows, never refuses", () => {
	beforeAll(async () => {
		await seedAuthz(); // the built-in role rows the regranted role references
	});

	it("keeps the oldest row with the best role and active-if-any, deletes the rest, rewrites the org grant, and creates the index", async () => {
		const USER = randomUUID();
		const ORG_ACTIVE = randomUUID(); // viewer (oldest, active) · admin (suspended) · member (active)
		const ORG_SUSPENDED = randomUUID(); // operator (oldest, suspended) · "admin,viewer" (suspended)
		const ORG_SINGLE = randomUUID(); // one owner row — untouched
		const OLDEST = randomUUID();
		const OLDEST_SUSPENDED = randomUUID();
		const SINGLE = randomUUID();

		let outcome = "not run";
		let members: MemberRow[] = [];
		let orgGrants: GrantRow[] = [];
		let indexExists = false;

		await getServiceDb()
			.transaction(async (tx) => {
				await tx.execute(sql`drop index if exists "member_organization_user_unique"`);
				await tx.execute(
					sql`insert into "user" (id, email) values (${USER}::uuid, ${`it-merge-${USER}@example.test`})`,
				);
				for (const org of [ORG_ACTIVE, ORG_SUSPENDED, ORG_SINGLE]) {
					await tx.execute(
						sql`insert into organization (id, name, slug) values (${org}::uuid, 'merge', ${`it-merge-${org.slice(0, 8)}`})`,
					);
				}
				await tx.execute(sql`
					insert into member (id, organization_id, user_id, role, status, created_at) values
					  (${OLDEST}::uuid, ${ORG_ACTIVE}::uuid, ${USER}::uuid, 'viewer', 'active', '2026-01-01'),
					  (gen_random_uuid(), ${ORG_ACTIVE}::uuid, ${USER}::uuid, 'admin', 'suspended', '2026-02-01'),
					  (gen_random_uuid(), ${ORG_ACTIVE}::uuid, ${USER}::uuid, 'member', 'active', '2026-03-01'),
					  (${OLDEST_SUSPENDED}::uuid, ${ORG_SUSPENDED}::uuid, ${USER}::uuid, 'operator', 'suspended', '2026-01-01'),
					  (gen_random_uuid(), ${ORG_SUSPENDED}::uuid, ${USER}::uuid, 'admin,viewer', 'suspended', '2026-02-01'),
					  (${SINGLE}::uuid, ${ORG_SINGLE}::uuid, ${USER}::uuid, 'owner', 'active', '2026-01-01')`);
				// The grant the oldest (viewer) row's lifecycle wrote, and an org-wide deny the merge must keep.
				await tx.execute(sql`
					insert into grants (org_id, principal_type, principal_id, role_id, resource_type)
					values (${ORG_ACTIVE}::uuid, 'user', ${USER}::uuid, ${BUILTIN_ROLE_IDS.viewer}::uuid, 'org')`);
				await tx.execute(sql`
					insert into grants (org_id, principal_type, principal_id, effect, permission_key, resource_type)
					select ${ORG_ACTIVE}::uuid, 'user', ${USER}::uuid, 'deny', key, 'org' from permission limit 1`);

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
							 order by effect, role_id`),
					);
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
		expect(members).toHaveLength(3);
		expect(byOrg.get(ORG_ACTIVE)).toEqual({
			id: OLDEST,
			organization_id: ORG_ACTIVE,
			role: "admin",
			status: "active",
		});
		expect(byOrg.get(ORG_SUSPENDED)).toEqual({
			id: OLDEST_SUSPENDED,
			organization_id: ORG_SUSPENDED,
			role: "admin,viewer",
			status: "suspended",
		});
		expect(byOrg.get(ORG_SINGLE)).toEqual({
			id: SINGLE,
			organization_id: ORG_SINGLE,
			role: "owner",
			status: "active",
		});
		const roleGrants = orgGrants.filter((g) => g.org_id === ORG_ACTIVE && g.role_id !== null);
		expect(roleGrants).toEqual([
			{ org_id: ORG_ACTIVE, effect: "allow", role_id: BUILTIN_ROLE_IDS.admin, permission_key: null },
		]);
		expect(orgGrants.filter((g) => g.effect === "deny")).toHaveLength(1);
		// A suspended membership gets no grant back from the merge.
		expect(orgGrants.some((g) => g.org_id === ORG_SUSPENDED)).toBe(false);
		expect(indexExists).toBe(true);
	});
});
