"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { and, eq, inArray } from "drizzle-orm";
import { recordActivity } from "@/lib/authz/activity";
import { emitAlertEventSafe } from "@/lib/alerts/emit";
import { actorHoldsAllKeys } from "@/lib/authz/ceiling";
import { getEntitlements } from "@/lib/authz/entitlements";
import { authorizeQuiet } from "@/lib/authz/guard";
import { PERMISSIONS } from "@/lib/authz/registry";
import { getTupleSync } from "@/lib/authz/tuple-sync";
import type { Actor } from "@/lib/authz/types";
import { ForbiddenError } from "@/lib/authz/types";
import { getServiceDb } from "@/lib/db";
import { role, rolePermission } from "@/lib/db/schema";

export interface CustomRole {
	id: string;
	name: string;
	permissionKeys: string[];
}

const VALID_KEYS: ReadonlySet<string> = new Set(PERMISSIONS.map((p) => p.key));

/** Keep only known, de-duplicated permission keys (no unsafe input reaches the DB). */
function sanitize(keys: string[]): string[] {
	return [...new Set(keys.filter((k) => VALID_KEYS.has(k)))];
}

/**
 * Gate for authoring custom roles. Enforces `member:manage_members` via the PDP FIRST — these are
 * `"use server"` actions imported by a client component, so without a PDP check any org member could
 * POST createRole/updateRole/deleteRole directly and rewrite (or destroy) the org's roles, including
 * self-granting every permission by rewriting a role's key set. THEN the Enterprise (customRoles)
 * entitlement. Uses `authorizeQuiet` (can(), not enforce()) because each mutation already records its
 * own governance Activity + alert event; enforce() would double-write. Mirrors grants.ts / the CLI
 * grants route. Both gates must pass; returns the resolved actor.
 */
async function requireCustomRoles(): Promise<Actor> {
	const actor = await authorizeQuiet("manage_members", { type: "member" });
	if (!getEntitlements(actor).customRoles) {
		throw new Error("Custom roles require an Enterprise license.");
	}
	return actor;
}

/** The active org's custom (non-built-in) roles with their permission keys. Reading the role config
 *  requires `member:view` (roles are member-management config; non-members are denied). */
export async function listCustomRoles(): Promise<CustomRole[]> {
	const actor = await authorizeQuiet("view", { type: "member" });
	const db = getServiceDb();
	const roles = await db
		.select({ id: role.id, name: role.name })
		.from(role)
		.where(and(eq(role.organization_id, actor.orgId), eq(role.is_builtin, false)));
	if (roles.length === 0) return [];

	const perms = await db
		.select({ roleId: rolePermission.role_id, key: rolePermission.permission_key })
		.from(rolePermission)
		.where(inArray(rolePermission.role_id, roles.map((r) => r.id)));
	const byRole = new Map<string, string[]>();
	for (const p of perms) {
		const list = byRole.get(p.roleId) ?? [];
		list.push(p.key);
		byRole.set(p.roleId, list);
	}
	return roles.map((r) => ({ ...r, permissionKeys: byRole.get(r.id) ?? [] }));
}

export async function createRole(
	name: string,
	permissionKeys: string[],
): Promise<CustomRole> {
	const actor = await requireCustomRoles();
	const keys = sanitize(permissionKeys);
	// Privilege ceiling: a role may never contain a permission its author doesn't hold, else an
	// admin could author (or, via updateRole, rewrite) a role to include billing/owner and escalate.
	if (!(await actorHoldsAllKeys(actor, keys))) {
		throw new ForbiddenError("manage_members", { type: "member" }, "role_exceeds_author_privilege");
	}
	const db = getServiceDb();
	const [created] = await db
		.insert(role)
		.values({ organization_id: actor.orgId, name, is_builtin: false })
		.returning({ id: role.id, name: role.name });
	if (keys.length > 0) {
		await db
			.insert(rolePermission)
			.values(keys.map((permission_key) => ({ role_id: created.id, permission_key })));
	}
	emitAlertEventSafe(actor.orgId, "authz.role.create", {
		title: `Role created: ${created.name}`,
		severity: "info",
		actor_id: actor.userId,
		action: "create",
		resource_type: "role",
		resource_id: created.id,
	});
	recordActivity(actor, "create", { type: "role", id: created.id });
	return { id: created.id, name: created.name, permissionKeys: keys };
}

export async function updateRole(
	id: string,
	name: string,
	permissionKeys: string[],
): Promise<void> {
	const actor = await requireCustomRoles();
	const keys = sanitize(permissionKeys);
	// Privilege ceiling: the new key set must be entirely within the editor's own permissions.
	// This is the load-bearing half — a role is a MUTABLE bundle, so without it an admin could
	// self-grant an empty role (ceiling passes vacuously) then rewrite it here to add billing/owner.
	if (!(await actorHoldsAllKeys(actor, keys))) {
		throw new ForbiddenError("manage_members", { type: "member" }, "role_exceeds_editor_privilege");
	}
	const db = getServiceDb();
	// Only this org's non-built-in roles may be edited.
	const [target] = await db
		.select({ id: role.id })
		.from(role)
		.where(
			and(
				eq(role.id, id),
				eq(role.organization_id, actor.orgId),
				eq(role.is_builtin, false),
			),
		)
		.limit(1);
	if (!target) throw new Error("Role not found");

	await db.update(role).set({ name }).where(eq(role.id, id));
	await db.delete(rolePermission).where(eq(rolePermission.role_id, id));
	if (keys.length > 0) {
		await db
			.insert(rolePermission)
			.values(keys.map((permission_key) => ({ role_id: id, permission_key })));
	}
	// Re-expand every grant on this role so its tuples reflect the new permissions.
	void getTupleSync()
		.resyncRole(id)
		.catch((err) => console.error("[authz] role resync failed:", err));

	emitAlertEventSafe(actor.orgId, "authz.role.edit", {
		title: `Role permissions changed: ${name}`,
		severity: "warning",
		actor_id: actor.userId,
		action: "edit",
		resource_type: "role",
		resource_id: id,
	});
	recordActivity(actor, "edit", { type: "role", id });
}

export async function deleteRole(id: string): Promise<void> {
	const actor = await requireCustomRoles();
	// Grants referencing the role cascade-delete (FK); their tuples reconcile on the
	// next backfill. Only this org's non-built-in roles may be deleted.
	await getServiceDb()
		.delete(role)
		.where(
			and(
				eq(role.id, id),
				eq(role.organization_id, actor.orgId),
				eq(role.is_builtin, false),
			),
		);
	emitAlertEventSafe(actor.orgId, "authz.role.delete", {
		title: "Role deleted",
		severity: "warning",
		actor_id: actor.userId,
		action: "delete",
		resource_type: "role",
		resource_id: id,
	});
	recordActivity(actor, "destroy", { type: "role", id });
}
