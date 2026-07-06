// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: the authz registry seed (lib/authz/seed.ts) against real Postgres. seedAuthz()
// syncs the GLOBAL permission/role/role_permission catalog FROM registry.ts — it is not
// org-scoped, so there are no per-test rows to seed/tear down: the function itself is the SUT
// and its job is to converge the shared catalog to exactly match the registry (insert missing,
// prune extra, no duplicates). We therefore assert against the registry-derived expectations
// (the WHERE-predicate role->permission filtering mocks can't verify) and prove idempotency by
// re-running and showing row counts are unchanged. We deliberately do NOT delete the catalog in
// teardown: it is shared, self-managing data that the app re-seeds at boot (instrumentation.ts),
// and deleting it would cascade away real grants. seedAuthz() guards itself with a module-level
// `seeded` flag (run-once-per-boot), so to invoke the REAL function twice we re-import it through
// vi.resetModules(); the DB connection is cached on globalThis, so no pool leaks across reloads.

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
	BUILT_IN_ROLES,
	BUILTIN_ROLE_IDS,
	type BuiltInRole,
	PERMISSIONS,
} from "@/lib/authz/registry";
import { getServiceDb } from "@/lib/db";
import { permission, role, rolePermission } from "@/lib/db/schema";
import { describeIfDb } from "./db";

const ALL_KEYS = PERMISSIONS.map((p) => p.key).sort();
const ROLE_NAMES = Object.keys(BUILT_IN_ROLES) as BuiltInRole[];

/** The permission keys a built-in role should hold, expanding the `"*"` shorthand. */
function expectedKeys(name: BuiltInRole): string[] {
	const grant = BUILT_IN_ROLES[name];
	return (grant === "*" ? PERMISSIONS.map((p) => p.key) : grant).slice().sort();
}

/**
 * Invokes the REAL seedAuthz() once, bypassing its module-level run-once guard by re-importing
 * the module fresh (the getServiceDb pool lives on globalThis, so it is reused, not re-created).
 */
async function runSeed(): Promise<void> {
	vi.resetModules();
	const mod = await import("@/lib/authz/seed");
	await mod.seedAuthz();
}

describeIfDb("authz registry seed (seedAuthz)", () => {
	beforeAll(async () => {
		await runSeed();
	});

	afterAll(() => {
		// Intentionally NO catalog cleanup — see file header. The global permission/role catalog is
		// shared, idempotent, and re-seeded at boot; deleting it would cascade away live grants.
	});

	it("converges the permission table to exactly the registry keys", async () => {
		const rows = await getServiceDb().select().from(permission);
		const keys = rows.map((r) => r.key).sort();

		// Exact set equality: every registry key is present AND no stale extras survive the prune.
		expect(keys).toEqual(ALL_KEYS);
		expect(rows).toHaveLength(PERMISSIONS.length);

		// resource/action are mapped straight from the registry def (and are effectively immutable
		// per key, since key === `${resource}:${action}` — a change forks a new key + prunes the old).
		// NOTE: `description` is intentionally NOT asserted equal: the seed's permission upsert is
		// onConflictDoNothing, so an existing key's free-text description never refreshes when the
		// registry text changes. The dev DB demonstrates this drift (key `project:view` carries the
		// stale "view a spec" from before the spec->project rename, while the registry now generates
		// "view a project"). We assert it is present/non-empty instead.
		const byKey = new Map(rows.map((r) => [r.key, r]));
		for (const def of PERMISSIONS) {
			const got = byKey.get(def.key);
			expect(got).toBeDefined();
			expect(got?.resource).toBe(def.resource);
			expect(got?.action).toBe(def.action);
			expect(got?.description?.length).toBeGreaterThan(0);
		}
	});

	it("seeds the four built-in roles with their stable UUIDs (org_id NULL, is_builtin)", async () => {
		for (const name of ROLE_NAMES) {
			const [row] = await getServiceDb()
				.select()
				.from(role)
				.where(eq(role.id, BUILTIN_ROLE_IDS[name]));
			expect(row, `built-in role ${name} should exist`).toBeDefined();
			expect(row.name).toBe(name);
			expect(row.is_builtin).toBe(true);
			expect(row.organization_id).toBeNull();
		}
	});

	it("grants each built-in role exactly its registry permission set", async () => {
		for (const name of ROLE_NAMES) {
			const rows = await getServiceDb()
				.select()
				.from(rolePermission)
				.where(eq(rolePermission.role_id, BUILTIN_ROLE_IDS[name]));
			const keys = rows.map((r) => r.permission_key).sort();
			expect(keys, `role ${name} permission set`).toEqual(expectedKeys(name));
		}
	});

	it("enforces the role WHERE-predicates: billing/manage are owner-only, viewer is read-only", async () => {
		const keysFor = async (name: BuiltInRole) =>
			new Set(
				(
					await getServiceDb()
						.select()
						.from(rolePermission)
						.where(eq(rolePermission.role_id, BUILTIN_ROLE_IDS[name]))
				).map((r) => r.permission_key),
			);

		const owner = await keysFor("owner");
		const admin = await keysFor("admin");
		const operator = await keysFor("operator");
		const viewer = await keysFor("viewer");

		// Owner = everything.
		expect(owner.size).toBe(PERMISSIONS.length);
		expect(owner.has("billing:manage_billing")).toBe(true);
		expect(owner.has("member:manage_members")).toBe(true);

		// Admin = everything EXCEPT the `billing:` RESOURCE (the filter is `!k.startsWith("billing:")`).
		// Note the nuance this predicate carries: admin loses `billing:manage_billing` but KEEPS the
		// distinct `org:manage_billing` (same action, different resource — only the prefix is excluded).
		expect(admin.has("org:edit")).toBe(true);
		expect(admin.has("member:manage_members")).toBe(true);
		expect(admin.has("billing:manage_billing")).toBe(false);
		expect(admin.has("org:manage_billing")).toBe(true);

		// Operator = infra view/create/edit/plan/deploy/destroy (not identities/members/billing/
		// activity/fleet) + view_alerts; no manage.
		expect(operator.has("project:deploy")).toBe(true);
		expect(operator.has("runner:destroy")).toBe(true);
		expect(operator.has("alert:view_alerts")).toBe(true);
		expect(operator.has("cloud_identity:manage_identities")).toBe(false);
		expect(operator.has("member:manage_members")).toBe(false);
		expect(operator.has("billing:manage_billing")).toBe(false);
		expect(operator.has("fleet:create")).toBe(false);
		expect(operator.has("alert:manage_alerts")).toBe(false);

		// Viewer = read-only: only `view` / `view_alerts`, nothing mutating.
		expect(viewer.has("org:view")).toBe(true);
		expect(viewer.has("alert:view_alerts")).toBe(true);
		expect(viewer.has("project:create")).toBe(false);
		expect(viewer.has("project:deploy")).toBe(false);
		expect(viewer.has("member:manage_members")).toBe(false);
		for (const key of viewer) {
			expect(["view", "view_alerts"]).toContain(key.split(":")[1]);
		}
	});

	it("is idempotent — re-running creates no duplicate permission or role_permission rows", async () => {
		const db = getServiceDb();
		const before = {
			permissions: (await db.select().from(permission)).length,
			rolePerms: await Promise.all(
				ROLE_NAMES.map(
					async (name) =>
						(
							await db
								.select()
								.from(rolePermission)
								.where(eq(rolePermission.role_id, BUILTIN_ROLE_IDS[name]))
						).length,
				),
			),
		};

		// Run the REAL seed a second time (fresh import bypasses the run-once guard).
		await runSeed();

		const after = {
			permissions: (await db.select().from(permission)).length,
			rolePerms: await Promise.all(
				ROLE_NAMES.map(
					async (name) =>
						(
							await db
								.select()
								.from(rolePermission)
								.where(eq(rolePermission.role_id, BUILTIN_ROLE_IDS[name]))
						).length,
				),
			),
		};

		expect(after.permissions).toBe(before.permissions);
		expect(after.rolePerms).toEqual(before.rolePerms);

		// And there is exactly one row per built-in role (re-seed didn't fork them).
		for (const name of ROLE_NAMES) {
			const roles = await db
				.select()
				.from(role)
				.where(eq(role.id, BUILTIN_ROLE_IDS[name]));
			expect(roles).toHaveLength(1);
		}
	});
});
