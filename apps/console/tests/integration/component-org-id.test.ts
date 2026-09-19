// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: the project component family's tenant column (#4116), against real Postgres.
//
// Every project-bearing table in lib/db/schema/project-components.ts now carries `org_id`, a copy of
// its project's `projects.org_id`. A denormalized tenant column that can drift is worse than none,
// so the claim this file owns is not "the column exists" — it is that NO WRITE CAN MAKE IT DISAGREE
// WITH THE PARENT. Each of the ways it could is driven here:
//
//   * a caller that stamps the WRONG org on insert (the trigger overwrites it);
//   * a caller that rewrites org_id, or moves the row to another project (re-derived);
//   * a parent that changes org (the propagation trigger rewrites every child);
//   * a parent that would lose its org while it has children (refused, not stranded);
//   * a row naming a project that does not exist (refused rather than stored with no tenant).
//
// THE FAMILY IS DERIVED, NOT LISTED. The first test reads the drizzle schema module and compares
// every table with a `project_id` column against `public.project_component_tables()`, the one list
// programmables.sql's trigger loop, backfill and propagation all read. A hand-written list here
// would agree with a hand-written list there and both could miss the next component table.
//
// THE RLS LIST IS DERIVED TOO (#4848). programmables.sql's owner_all loop reads the same function,
// and a catalog test below asserts every family table has RLS enabled and that policy, minus
// RLS_EXCEPTIONS — a named set that is empty today and is checked in both directions, so an entry
// cannot outlive its table and a table cannot quietly join it. Until #4848 that loop had its own
// 17-name literal and four tables of the family had no policy at all.
//
// The RLS behaviour half needs the distinct app role (the migration role is BYPASSRLS, so an
// isolation test run through it passes by construction) and skips without one — see
// APP_ROLE_DISTINCT in ./db. The catalog half reads pg_class/pg_policy and runs everywhere.

import { randomUUID } from "node:crypto";
import { eq, inArray, is, sql } from "drizzle-orm";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, expect, it } from "vitest";
import { z } from "zod";
import { type Tx, getServiceDb, withOwnerScope, withScope } from "@/lib/db";
import {
	projectAddons,
	projectCluster,
	projectIacSources,
	projectServices,
	projectSourceRepos,
	projects,
} from "@/lib/db/schema";
import * as components from "@/lib/db/schema/project-components";
import { APP_ROLE_DISTINCT, describeIfDb, refusalText } from "./db";

const ORG_A = randomUUID();
const ORG_B = randomUUID();
const ORG_C = randomUUID();
/** Owns the Teams-shaped project in ORG_A; a different user from the org id. */
const OWNER_A = randomUUID();
/** A teammate in ORG_A who did not create the project. */
const TEAMMATE_A = randomUUID();
const OWNER_B = randomUUID();

let projectA = "";
let projectB = "";

const idRows = z.array(z.object({ id: z.string() }));
const orgRows = z.array(z.object({ org_id: z.string().nullable() }));
const familyRow = z.array(z.object({ tables: z.array(z.string()) }));
const nameRows = z.array(z.object({ name: z.string() }));
const policyRows = z.array(
	z.object({
		name: z.string(),
		rls: z.boolean(),
		cmd: z.string().nullable(),
		qual: z.string().nullable(),
		check: z.string().nullable(),
	}),
);
const insertedRows = z.array(z.object({ id: z.string(), org_id: z.string().nullable() }));

/**
 * Family tables deliberately WITHOUT the owner_all tenant policy. Empty: every table that carries the
 * derived org_id answers to it. An entry here must name a family table that really has no policy —
 * the catalog test fails in both directions, so the set cannot drift from the database.
 */
const RLS_EXCEPTIONS: readonly string[] = [];

/** One table's app-role insert and read, so the same RLS assertions can drive each table. */
interface RlsCase {
	table: string;
	/** Inserts one minimal row for `projectId` and returns its id and the org_id the DB stored. */
	insert: (tx: Tx, projectId: string) => Promise<unknown>;
	/** Selects the row by id; RLS decides whether it comes back. */
	read: (tx: Tx, id: string) => Promise<unknown>;
}

/** A short unique suffix, so each insert clears the tables' per-env UNIQUE keys. */
function tag(): string {
	return randomUUID().slice(0, 8);
}

/**
 * The four tables that had no RLS policy until #4848. Each gets the full behavioural drive below: a
 * cross-tenant INSERT … RETURNING org_id is refused, a same-org write returns the parent's org, and
 * another org reads nothing.
 */
const NEWLY_POLICED: readonly RlsCase[] = [
	{
		table: "project_addons",
		insert: (tx, projectId) =>
			tx
				.insert(projectAddons)
				.values({ project_id: projectId, addon_id: `a-${tag()}` })
				.returning({ id: projectAddons.id, org_id: projectAddons.org_id }),
		read: (tx, id) =>
			tx.select({ id: projectAddons.id }).from(projectAddons).where(eq(projectAddons.id, id)),
	},
	{
		table: "project_services",
		insert: (tx, projectId) =>
			tx
				.insert(projectServices)
				.values({
					project_id: projectId,
					name: `s-${tag()}`,
					source: { kind: "image", image: "nginx:1.27" },
				})
				.returning({ id: projectServices.id, org_id: projectServices.org_id }),
		read: (tx, id) =>
			tx.select({ id: projectServices.id }).from(projectServices).where(eq(projectServices.id, id)),
	},
	{
		table: "project_source_repos",
		insert: (tx, projectId) =>
			tx
				.insert(projectSourceRepos)
				.values({ project_id: projectId, repo_url: `https://example.com/${tag()}.git` })
				.returning({ id: projectSourceRepos.id, org_id: projectSourceRepos.org_id }),
		read: (tx, id) =>
			tx
				.select({ id: projectSourceRepos.id })
				.from(projectSourceRepos)
				.where(eq(projectSourceRepos.id, id)),
	},
	{
		table: "project_iac_sources",
		insert: (tx, projectId) =>
			tx
				.insert(projectIacSources)
				.values({ project_id: projectId, repo_url: `https://example.com/${tag()}.git` })
				.returning({ id: projectIacSources.id, org_id: projectIacSources.org_id }),
		read: (tx, id) =>
			tx
				.select({ id: projectIacSources.id })
				.from(projectIacSources)
				.where(eq(projectIacSources.id, id)),
	},
];

/** Every table in project-components.ts that carries a `project_id` column, by SQL name. */
function schemaFamily(): string[] {
	const names: string[] = [];
	for (const value of Object.values(components)) {
		if (!is(value, PgTable)) continue;
		const cfg = getTableConfig(value);
		if (cfg.columns.some((c) => c.name === "project_id")) names.push(cfg.name);
	}
	return names.sort();
}

/** Inserts one cluster row through the service role, with an optional caller-supplied org. */
async function insertCluster(projectId: string, orgId?: string): Promise<string> {
	const rows = await getServiceDb()
		.insert(projectCluster)
		.values({ project_id: projectId, org_id: orgId, cluster_name: `c-${randomUUID().slice(0, 6)}` })
		.returning({ id: projectCluster.id });
	return idRows.parse(rows)[0].id;
}

/** The stored org of one cluster row, read through the service role. */
async function clusterOrg(id: string): Promise<string | null> {
	const rows = await getServiceDb()
		.select({ org_id: projectCluster.org_id })
		.from(projectCluster)
		.where(eq(projectCluster.id, id));
	return orgRows.parse(rows)[0].org_id;
}

describeIfDb("project component family: org_id is derived, never written (#4116)", () => {
	beforeAll(async () => {
		const rows = await getServiceDb()
			.insert(projects)
			.values([
				{
					user_id: OWNER_A,
					org_id: ORG_A,
					project_name: `org-a-${ORG_A.slice(0, 6)}`,
					region: "eu-west-1",
					iac_version: "1.0.0",
				},
				{
					user_id: OWNER_B,
					org_id: ORG_B,
					project_name: `org-b-${ORG_B.slice(0, 6)}`,
					region: "eu-west-1",
					iac_version: "1.0.0",
				},
			])
			.returning({ id: projects.id });
		[projectA, projectB] = idRows.parse(rows).map((r) => r.id);
	});

	afterAll(async () => {
		// Every component table cascades from projects.
		await getServiceDb()
			.delete(projects)
			.where(inArray(projects.id, [projectA, projectB].filter(Boolean)));
	});

	it("the SQL family is exactly the schema's project-bearing tables", async () => {
		const derived = schemaFamily();
		// Non-vacuity: a schema walk that found nothing would make the equality below trivially true.
		expect(derived).toContain("project_cluster");
		expect(derived.length).toBeGreaterThan(15);
		// audit_log carries project_id but is an audit trail, not a component — it is the one
		// project-bearing table in the file deliberately outside the family.
		const expected = derived.filter((t) => t !== "audit_log");
		const res = await getServiceDb().execute(
			sql`select public.project_component_tables() as tables`,
		);
		const inSql = [...familyRow.parse(res)[0].tables].sort();
		expect(inSql).toEqual(expected);
	});

	it("every family table has the derivation trigger and the NOT NULL check", async () => {
		const res = await getServiceDb().execute(sql`
			select c.relname as name
			  from pg_class c
			  join pg_trigger tg on tg.tgrelid = c.oid and not tg.tgisinternal
			  join pg_proc f on f.oid = tg.tgfoid
			 where c.relnamespace = 'public'::regnamespace
			   and f.proname = 'derive_component_org_id'
			   and tg.tgname = c.relname || '_set_org_id'
			   and tg.tgenabled <> 'D'
		`);
		const triggered = nameRows.parse(res).map((r) => r.name).sort();
		const checks = await getServiceDb().execute(sql`
			select conrelid::regclass::text as name
			  from pg_constraint
			 where contype = 'c' and conname = conrelid::regclass::text || '_org_id_nn'
			   and convalidated
		`);
		const checked = nameRows.parse(checks).map((r) => r.name).sort();
		const family = schemaFamily().filter((t) => t !== "audit_log");
		expect(triggered).toEqual(family);
		expect(checked).toEqual(family);
	});

	it("overwrites a caller-supplied org with the parent's", async () => {
		const id = await insertCluster(projectA, ORG_B);
		expect(await clusterOrg(id)).toBe(ORG_A);
		// And when the caller supplies none, which is every app insert today.
		const bare = await insertCluster(projectA);
		expect(await clusterOrg(bare)).toBe(ORG_A);
	});

	it("re-derives on a direct rewrite of org_id and on a move to another project", async () => {
		const id = await insertCluster(projectA);
		await getServiceDb()
			.update(projectCluster)
			.set({ org_id: ORG_B })
			.where(eq(projectCluster.id, id));
		expect(await clusterOrg(id)).toBe(ORG_A);

		await getServiceDb()
			.update(projectCluster)
			.set({ project_id: projectB })
			.where(eq(projectCluster.id, id));
		expect(await clusterOrg(id)).toBe(ORG_B);
	});

	it("refuses a row whose project does not exist, rather than storing it with no tenant", async () => {
		const text = await refusalText(() => insertCluster(randomUUID()));
		expect(text).toMatch(/cannot derive project_cluster\.org_id/);
	});

	it("takes every child with the project when the project changes org", async () => {
		const id = await insertCluster(projectB);
		const addon = idRows.parse(
			await getServiceDb()
				.insert(projectAddons)
				.values({ project_id: projectB, addon_id: "cert-manager" })
				.returning({ id: projectAddons.id }),
		)[0].id;
		try {
			await getServiceDb()
				.update(projects)
				.set({ org_id: ORG_C })
				.where(eq(projects.id, projectB));
			expect(await clusterOrg(id)).toBe(ORG_C);
			const addonOrg = orgRows.parse(
				await getServiceDb()
					.select({ org_id: projectAddons.org_id })
					.from(projectAddons)
					.where(eq(projectAddons.id, addon)),
			)[0].org_id;
			expect(addonOrg).toBe(ORG_C);
		} finally {
			await getServiceDb()
				.update(projects)
				.set({ org_id: ORG_B })
				.where(eq(projects.id, projectB));
		}
		expect(await clusterOrg(id)).toBe(ORG_B);
	});

	it("refuses to strip a project's org while it still has components", async () => {
		await insertCluster(projectB);
		const text = await refusalText(() =>
			getServiceDb().update(projects).set({ org_id: null }).where(eq(projects.id, projectB)),
		);
		expect(text).toMatch(/cannot derive project_\w+\.org_id/);
	});

	it("every family table has RLS and the owner_all tenant policy, minus RLS_EXCEPTIONS (#4848)", async () => {
		const family = schemaFamily().filter((t) => t !== "audit_log");
		// Non-vacuity: the four tables #4848 added a policy to must be IN the family this walks.
		for (const c of NEWLY_POLICED) expect(family).toContain(c.table);
		const res = await getServiceDb().execute(sql`
			select c.relname as name,
			       c.relrowsecurity as rls,
			       p.polcmd::text as cmd,
			       pg_get_expr(p.polqual, p.polrelid) as qual,
			       pg_get_expr(p.polwithcheck, p.polrelid) as "check"
			  from pg_class c
			  left join pg_policy p on p.polrelid = c.oid and p.polname = 'owner_all'
			 where c.relnamespace = 'public'::regnamespace
			   and c.relname = any(public.project_component_tables())
		`);
		const rows = policyRows.parse(res);
		expect(rows.map((r) => r.name).sort()).toEqual(family);
		// The exception set names real family tables and nothing else.
		for (const t of RLS_EXCEPTIONS) expect(family).toContain(t);
		// The policy is the org-COLUMN form: USING and WITH CHECK both bind the row's own org_id to the
		// session org, for every command. Anchored at the start of the deparsed expression, where
		// pg_get_expr puts the OR's first operand; a join-through policy starts `(project_id IN` and a
		// USING-only one has no WITH CHECK, so neither matches.
		const orgArm = /^\(*org_id = \(*current_setting\('app\.current_org'/;
		const policed = rows
			.filter((r) => r.rls && r.cmd === "*" && orgArm.test(r.qual ?? "") && orgArm.test(r.check ?? ""))
			.map((r) => r.name)
			.sort();
		expect(policed).toEqual(family.filter((t) => !RLS_EXCEPTIONS.includes(t)));
		// And an exception really is one: listed tables carry no owner_all at all.
		const unpoliced = rows.filter((r) => r.qual === null).map((r) => r.name).sort();
		expect(unpoliced).toEqual([...RLS_EXCEPTIONS].sort());
	});

	it.skipIf(!APP_ROLE_DISTINCT)(
		"a writer whose scope cannot see the parent is refused by the POLICY, not by the derivation",
		async () => {
			// withOwnerScope scopes the org GUC to the USER id, so the teammate's scope cannot see ORG_A's
			// project row. The definer-rights derivation still reads it and stamps ORG_A; the owner_all
			// WITH CHECK then refuses a row of an org the scope does not hold. An invoker-rights
			// derivation would instead raise "cannot derive … does not exist" about a project that does.
			const text = await refusalText(() =>
				withOwnerScope(TEAMMATE_A, (tx) =>
					tx.insert(projectAddons).values({ project_id: projectA, addon_id: "external-dns" }),
				),
			);
			expect(text).toMatch(/row-level security/);
			expect(text).not.toMatch(/cannot derive/);
		},
	);

	for (const c of NEWLY_POLICED) {
		it.skipIf(!APP_ROLE_DISTINCT)(
			`${c.table}: a cross-tenant INSERT … RETURNING org_id is refused, never answered (#4848)`,
			async () => {
				// The leak #4848 closed: naming another tenant's project_id and asking for org_id back.
				const text = await refusalText(() =>
					withScope({ ownerId: TEAMMATE_A, orgId: ORG_A }, (tx) => c.insert(tx, projectB)),
				);
				expect(text).toMatch(/row-level security/);
			},
		);

		it.skipIf(!APP_ROLE_DISTINCT)(
			`${c.table}: a same-org writer gets the parent's org; another org reads nothing (#4848)`,
			async () => {
				// The teammate did not create the project: the ORG arm is what admits the write.
				const row = insertedRows.parse(
					await withScope({ ownerId: TEAMMATE_A, orgId: ORG_A }, (tx) => c.insert(tx, projectA)),
				)[0];
				expect(row.org_id).toBe(ORG_A);

				const asTeammate = idRows.parse(
					await withScope({ ownerId: TEAMMATE_A, orgId: ORG_A }, (tx) => c.read(tx, row.id)),
				);
				expect(asTeammate).toHaveLength(1);

				const asOtherOrg = idRows.parse(
					await withScope({ ownerId: OWNER_B, orgId: ORG_B }, (tx) => c.read(tx, row.id)),
				);
				expect(asOtherOrg).toHaveLength(0);
			},
		);
	}

	it.skipIf(!APP_ROLE_DISTINCT)(
		"RLS binds the org arm to the row's own org_id: a teammate sees it, another org does not",
		async () => {
			const id = await insertCluster(projectA);
			const asTeammate = await withScope({ ownerId: TEAMMATE_A, orgId: ORG_A }, (tx) =>
				tx.select({ id: projectCluster.id }).from(projectCluster).where(eq(projectCluster.id, id)),
			);
			expect(asTeammate).toHaveLength(1);

			const asOtherOrg = await withScope({ ownerId: OWNER_B, orgId: ORG_B }, (tx) =>
				tx.select({ id: projectCluster.id }).from(projectCluster).where(eq(projectCluster.id, id)),
			);
			expect(asOtherOrg).toHaveLength(0);

			// The owner arm is unchanged: the project's creator, scoped to a DIFFERENT org, still
			// sees it — exactly as the join-through policy this replaced allowed.
			const asOwnerElsewhere = await withScope({ ownerId: OWNER_A, orgId: ORG_C }, (tx) =>
				tx.select({ id: projectCluster.id }).from(projectCluster).where(eq(projectCluster.id, id)),
			);
			expect(asOwnerElsewhere).toHaveLength(1);
		},
	);

	it.skipIf(!APP_ROLE_DISTINCT)(
		"refuses a write naming another org's project (WITH CHECK sees the derived org)",
		async () => {
			const text = await refusalText(() =>
				withScope({ ownerId: TEAMMATE_A, orgId: ORG_A }, (tx) =>
					tx.insert(projectCluster).values({ project_id: projectB, cluster_name: "evil" }),
				),
			);
			expect(text).toMatch(/row-level security/);
		},
	);
});
