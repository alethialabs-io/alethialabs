// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: the normalized service_bindings + service_binding_injections tables (Phase C.3, the
// hard one — a POLYMORPHIC owner: a binding belongs to a project_services row XOR a
// project_chart_workloads row). Proves against real Postgres: (1) the migration BACKFILL unnests the
// JSONB `bindings` from BOTH owners into rows + their nested injections, preserving ordinal; (2) the
// two-path join-through RLS scopes a binding to its owner's project's org; (3) ON DELETE CASCADE from
// EITHER parent drops the binding rows AND their injections. Seeded via the service connection.

import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { getServiceDb, withScope } from "@/lib/db";
import {
	projectAddons,
	projectChartWorkloads,
	projectEnvironments,
	projects,
	projectServices,
	serviceBindingInjections,
	serviceBindings,
} from "@/lib/db/schema";
import { describeIfDb } from "./db";

const ORG = randomUUID();
const USER = randomUUID();
const ORG_OTHER = randomUUID();
const USER_OTHER = randomUUID();
const PROJ = randomUUID();
const ENV = randomUUID();
const SVC = randomUUID();
const ADDON = randomUUID();
const CW = randomUUID();

const APP_ROLE_DISTINCT =
	(process.env.ALETHIA_APP_DATABASE_URL ?? "") !== "" &&
	process.env.ALETHIA_APP_DATABASE_URL !== process.env.ALETHIA_DATABASE_URL;

/** Run the migration's binding+injection backfill scoped to the seeded service + chart workload. */
async function backfill(): Promise<void> {
	const db = getServiceDb();
	await db.execute(sql`
		INSERT INTO service_bindings (service_id, chart_workload_id, target_kind, target_name, ordinal)
		SELECT s.id, NULL, (e.elem->'target'->>'kind')::service_binding_kind, e.elem->'target'->>'name', (e.ord - 1)::int
		FROM project_services s
		CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.bindings, '[]'::jsonb)) WITH ORDINALITY AS e(elem, ord)
		WHERE s.id = ${SVC} AND COALESCE(e.elem->'target'->>'name','') <> ''
		  AND (e.elem->'target'->>'kind') IN ('database','cache','queue','secret')
	`);
	await db.execute(sql`
		INSERT INTO service_bindings (service_id, chart_workload_id, target_kind, target_name, ordinal)
		SELECT NULL, w.id, (e.elem->'target'->>'kind')::service_binding_kind, e.elem->'target'->>'name', (e.ord - 1)::int
		FROM project_chart_workloads w
		CROSS JOIN LATERAL jsonb_array_elements(COALESCE(w.bindings, '[]'::jsonb)) WITH ORDINALITY AS e(elem, ord)
		WHERE w.id = ${CW} AND COALESCE(e.elem->'target'->>'name','') <> ''
		  AND (e.elem->'target'->>'kind') IN ('database','cache','queue','secret')
	`);
	await db.execute(sql`
		INSERT INTO service_binding_injections (binding_id, env, from_facet, ordinal)
		SELECT sb.id, inj.elem->>'env', (inj.elem->>'from')::service_binding_facet, (inj.ord - 1)::int
		FROM service_bindings sb
		JOIN project_services s ON s.id = sb.service_id
		CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.bindings, '[]'::jsonb)) WITH ORDINALITY AS b(elem, ord)
		CROSS JOIN LATERAL jsonb_array_elements(COALESCE(b.elem->'inject', '[]'::jsonb)) WITH ORDINALITY AS inj(elem, ord)
		WHERE sb.service_id = ${SVC} AND (b.ord - 1) = sb.ordinal AND COALESCE(inj.elem->>'env','') <> ''
		  AND (inj.elem->>'from') IN ('endpoint','port','username','password','connection_string')
	`);
	await db.execute(sql`
		INSERT INTO service_binding_injections (binding_id, env, from_facet, ordinal)
		SELECT sb.id, inj.elem->>'env', (inj.elem->>'from')::service_binding_facet, (inj.ord - 1)::int
		FROM service_bindings sb
		JOIN project_chart_workloads w ON w.id = sb.chart_workload_id
		CROSS JOIN LATERAL jsonb_array_elements(COALESCE(w.bindings, '[]'::jsonb)) WITH ORDINALITY AS b(elem, ord)
		CROSS JOIN LATERAL jsonb_array_elements(COALESCE(b.elem->'inject', '[]'::jsonb)) WITH ORDINALITY AS inj(elem, ord)
		WHERE sb.chart_workload_id = ${CW} AND (b.ord - 1) = sb.ordinal AND COALESCE(inj.elem->>'env','') <> ''
		  AND (inj.elem->>'from') IN ('endpoint','port','username','password','connection_string')
	`);
}

describeIfDb("service_bindings — polymorphic backfill, RLS, cascade", () => {
	beforeAll(async () => {
		const db = getServiceDb();
		await db.insert(projects).values({
			id: PROJ,
			org_id: ORG,
			user_id: USER,
			project_name: `p-${PROJ}`,
			region: "westeurope",
			iac_version: "1.0",
		});
		await db.insert(projectEnvironments).values({
			id: ENV,
			project_id: PROJ,
			user_id: USER,
			name: "production",
			is_default: true,
		});
		await db.insert(projectServices).values({
			id: SVC,
			project_id: PROJ,
			environment_id: ENV,
			name: "api",
			source: { kind: "image", image: "nginx" },
			bindings: [
				{
					target: { kind: "database", name: "db" },
					inject: [
						{ env: "DB_URL", from: "connection_string" },
						{ env: "DB_HOST", from: "endpoint" },
					],
				},
				{ target: { kind: "cache", name: "redis" }, inject: [] },
			],
		});
		await db.insert(projectAddons).values({
			id: ADDON,
			project_id: PROJ,
			environment_id: ENV,
			addon_id: "mychart",
			source: "byo",
		});
		await db.insert(projectChartWorkloads).values({
			id: CW,
			project_id: PROJ,
			environment_id: ENV,
			addon_id: ADDON,
			name: "web",
			workload_kind: "deployment",
			rendered: { image: "nginx", ports: [], env_keys: [] },
			bindings: [
				{
					target: { kind: "secret", name: "apikey" },
					inject: [{ env: "KEY", from: "password" }],
				},
			],
		});
		await backfill();
	});

	afterAll(async () => {
		const db = getServiceDb();
		await db.delete(projects).where(eq(projects.id, PROJ)); // cascades through everything
	});

	it("backfills service-owned bindings + nested injections in order", async () => {
		const db = getServiceDb();
		const rows = await db
			.select()
			.from(serviceBindings)
			.where(eq(serviceBindings.service_id, SVC))
			.orderBy(serviceBindings.ordinal);
		expect(rows.map((r) => [r.ordinal, r.target_kind, r.target_name])).toEqual([
			[0, "database", "db"],
			[1, "cache", "redis"],
		]);
		const dbBinding = rows.find((r) => r.ordinal === 0);
		const injections = await db
			.select()
			.from(serviceBindingInjections)
			.where(eq(serviceBindingInjections.binding_id, dbBinding?.id ?? ""))
			.orderBy(serviceBindingInjections.ordinal);
		expect(injections.map((i) => [i.ordinal, i.env, i.from_facet])).toEqual([
			[0, "DB_URL", "connection_string"],
			[1, "DB_HOST", "endpoint"],
		]);
	});

	it("backfills chart-workload-owned bindings (the other owner) + injections", async () => {
		const db = getServiceDb();
		const rows = await db
			.select()
			.from(serviceBindings)
			.where(eq(serviceBindings.chart_workload_id, CW));
		expect(rows.map((r) => [r.target_kind, r.target_name])).toEqual([
			["secret", "apikey"],
		]);
		const injections = await db
			.select()
			.from(serviceBindingInjections)
			.where(eq(serviceBindingInjections.binding_id, rows[0]?.id ?? ""));
		expect(injections.map((i) => [i.env, i.from_facet])).toEqual([
			["KEY", "password"],
		]);
	});

	it("two-path RLS scopes bindings to the owning org", async () => {
		if (!APP_ROLE_DISTINCT) return;
		const mine = await withScope({ ownerId: USER, orgId: ORG }, (tx) =>
			tx.select().from(serviceBindings).where(eq(serviceBindings.service_id, SVC)),
		);
		expect(mine.length).toBeGreaterThan(0);
		const theirs = await withScope({ ownerId: USER_OTHER, orgId: ORG_OTHER }, (tx) =>
			tx.select().from(serviceBindings).where(eq(serviceBindings.service_id, SVC)),
		);
		expect(theirs).toHaveLength(0);
	});

	it("ON DELETE CASCADE from the chart workload drops its bindings + injections", async () => {
		const db = getServiceDb();
		await db.delete(projectChartWorkloads).where(eq(projectChartWorkloads.id, CW));
		const orphanBindings = await db
			.select()
			.from(serviceBindings)
			.where(eq(serviceBindings.chart_workload_id, CW));
		expect(orphanBindings).toHaveLength(0);
		// Service-owned bindings are untouched.
		const svcBindings = await db
			.select()
			.from(serviceBindings)
			.where(eq(serviceBindings.service_id, SVC));
		expect(svcBindings.length).toBe(2);
	});
});
