// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: the normalized service_bindings + service_binding_injections tables — now the SOLE
// source (the parent `bindings` JSONB was dropped in the contract phase, #1426). A binding has a
// POLYMORPHIC owner: a project_services row XOR a project_chart_workloads row. Proves against real
// Postgres: (1) `serviceBindingsByOwner` reconstructs the ServiceBinding[] byte-identically for BOTH
// owners, incl. nested injections in ordinal order AND the BYO-IaC target fields (#824: target_address
// + output_keys), with a first-class-component target round-tripping as `{ kind, name }` (no address/
// output_keys); (2) the two-path join-through RLS scopes a binding to its owner's project's org;
// (3) ON DELETE CASCADE from EITHER parent drops the binding rows AND their injections. Seeded via the
// real writer (`insertServiceBindings`) through the service connection.

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { getServiceDb, withScope } from "@/lib/db";
import { serviceBindingsByOwner } from "@/lib/db/normalized-reads";
import { insertServiceBindings } from "@/lib/db/service-bindings-sync";
import {
	projectAddons,
	projectChartWorkloads,
	projectEnvironments,
	projects,
	projectServices,
	serviceBindingInjections,
	serviceBindings,
} from "@/lib/db/schema";
import type { ServiceBinding } from "@/types/jsonb.types";
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

// The canonical bindings the writer stores and the reader must reconstruct byte-for-byte. `db` is a
// BYO-IaC target (#824 — exercises target_address + output_keys + multiple ordered injections);
// `redis` is a first-class-component target (no address/output_keys, empty inject) that must
// round-trip as `{ target: { kind, name }, inject: [] }` — the omit-when-null contract.
const SVC_BINDINGS: ServiceBinding[] = [
	{
		target: {
			kind: "database",
			name: "db",
			address: "module.rds.this",
			output_keys: {
				endpoint: "rds_endpoint",
				port: "rds_port",
				credential_secret: "rds_secret_arn",
			},
		},
		inject: [
			{ env: "DB_URL", from: "connection_string" },
			{ env: "DB_HOST", from: "endpoint" },
		],
	},
	{ target: { kind: "cache", name: "redis" }, inject: [] },
];

const CW_BINDINGS: ServiceBinding[] = [
	{
		target: { kind: "secret", name: "apikey" },
		inject: [{ env: "KEY", from: "password" }],
	},
];

describeIfDb("service_bindings — reconstruction, RLS, cascade", () => {
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
		});
		// Seed the child tables via the real writer (the same path the save action runs).
		await db.transaction(async (tx) => {
			await insertServiceBindings(tx, { service_id: SVC }, SVC_BINDINGS);
			await insertServiceBindings(tx, { chart_workload_id: CW }, CW_BINDINGS);
		});
	});

	afterAll(async () => {
		const db = getServiceDb();
		await db.delete(projects).where(eq(projects.id, PROJ)); // cascades through everything
	});

	it("reconstructs service-owned bindings byte-identically (BYO-IaC target + ordered injections)", async () => {
		const map = await serviceBindingsByOwner(getServiceDb(), {
			serviceIds: [SVC],
			chartWorkloadIds: [],
		});
		expect(map.get(SVC)).toEqual(SVC_BINDINGS);
	});

	it("reconstructs chart-workload-owned bindings (the other owner)", async () => {
		const map = await serviceBindingsByOwner(getServiceDb(), {
			serviceIds: [],
			chartWorkloadIds: [CW],
		});
		expect(map.get(CW)).toEqual(CW_BINDINGS);
	});

	it("reconstructs both owners in one batched call, keyed by owner id", async () => {
		const map = await serviceBindingsByOwner(getServiceDb(), {
			serviceIds: [SVC],
			chartWorkloadIds: [CW],
		});
		expect(map.get(SVC)).toEqual(SVC_BINDINGS);
		expect(map.get(CW)).toEqual(CW_BINDINGS);
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
		const [cwBinding] = await db
			.select()
			.from(serviceBindings)
			.where(eq(serviceBindings.chart_workload_id, CW));
		await db.delete(projectChartWorkloads).where(eq(projectChartWorkloads.id, CW));
		const orphanBindings = await db
			.select()
			.from(serviceBindings)
			.where(eq(serviceBindings.chart_workload_id, CW));
		expect(orphanBindings).toHaveLength(0);
		// The injections of the deleted binding cascade too.
		const orphanInjections = await db
			.select()
			.from(serviceBindingInjections)
			.where(eq(serviceBindingInjections.binding_id, cwBinding?.id ?? ""));
		expect(orphanInjections).toHaveLength(0);
		// Service-owned bindings are untouched.
		const svcBindings = await db
			.select()
			.from(serviceBindings)
			.where(eq(serviceBindings.service_id, SVC));
		expect(svcBindings.length).toBe(2);
	});
});
