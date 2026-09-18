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
// The RLS half needs the distinct app role (the migration role is BYPASSRLS, so an isolation test
// run through it passes by construction) and skips without one — see APP_ROLE_DISTINCT in ./db.

import { randomUUID } from "node:crypto";
import { eq, inArray, is, sql } from "drizzle-orm";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, expect, it } from "vitest";
import { z } from "zod";
import { getServiceDb, withOwnerScope, withScope } from "@/lib/db";
import { projectAddons, projectCluster, projects } from "@/lib/db/schema";
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

	it.skipIf(!APP_ROLE_DISTINCT)(
		"derives the parent's org even when the writer's scope cannot see the parent",
		async () => {
			// project_addons has no RLS policy, and withOwnerScope scopes the org GUC to the USER id,
			// so the teammate's scope cannot see ORG_A's project row. An invoker-rights derivation would
			// read nothing and refuse this insert — which succeeded before #4116. Definer rights keep it
			// succeeding, stamped with the org that actually owns the project.
			const rows = await withOwnerScope(TEAMMATE_A, (tx) =>
				tx
					.insert(projectAddons)
					.values({ project_id: projectA, addon_id: "external-dns" })
					.returning({ org_id: projectAddons.org_id }),
			);
			expect(orgRows.parse(rows)[0].org_id).toBe(ORG_A);
		},
	);

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
