"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { and, asc, eq, exists, inArray, isNotNull, or, sql } from "drizzle-orm";
import { recordActivity } from "@/lib/authz/activity";
import { emitAlertEventSafe } from "@/lib/alerts/emit";
import { getPdp } from "@/lib/authz";
import { actorHoldsAllKeys } from "@/lib/authz/ceiling";
import { getEntitlements } from "@/lib/authz/entitlements";
import { authorizeQuiet } from "@/lib/authz/guard";
import {
	BUILT_IN_ROLE_DESCRIPTIONS,
	BUILT_IN_ROLES,
	BUILTIN_ROLE_IDS,
	type BuiltInRole,
	type PermissionDef,
	PERMISSIONS,
} from "@/lib/authz/registry";
import { getTupleSync } from "@/lib/authz/tuple-sync";
import type { Actor } from "@/lib/authz/types";
import { ForbiddenError } from "@/lib/authz/types";
import { getServiceDb } from "@/lib/db";
import { likeTerm } from "@/lib/db/like";
import { grants, role, rolePermission } from "@/lib/db/schema";

export interface CustomRole {
	id: string;
	name: string;
	description: string | null;
	permissionKeys: string[];
}

/** A role (built-in or custom) shaped for the Roles surface. */
export interface RoleRow {
	id: string;
	name: string;
	description: string | null;
	builtin: boolean;
	permissionKeys: string[];
	/** Distinct user principals granted this role in the active org (drives the delete dialog). */
	grantCount: number;
}

/** Everything the Roles page needs that isn't the searchable custom-role list. */
export interface RolesBootstrap {
	builtin: RoleRow[];
	permissions: PermissionDef[];
	/** Enterprise entitlement — authoring custom roles. */
	customRoles: boolean;
	/** Non-throwing PDP check — drives whether create/edit/delete affordances are enabled. */
	canManage: boolean;
}

const ALL_KEYS: string[] = PERMISSIONS.map((p) => p.key);
const VALID_KEYS: ReadonlySet<string> = new Set(ALL_KEYS);
const ORDER: BuiltInRole[] = ["owner", "admin", "operator", "viewer"];

/** Keep only known, de-duplicated permission keys (no unsafe input reaches the DB). */
function sanitize(keys: string[]): string[] {
	return [...new Set(keys.filter((k) => VALID_KEYS.has(k)))];
}

/** The permission keys a built-in role grants ("*" → every key). */
function builtinKeys(name: BuiltInRole): string[] {
	const grant = BUILT_IN_ROLES[name];
	return grant === "*" ? ALL_KEYS : grant;
}

/**
 * Distinct-USER grant counts per role in an org. Counts only `user` principals (team grants
 * contribute 0) and de-duplicates a principal that holds the role both org-wide and scoped, so
 * "N members affected" is accurate. Roles with no grants are absent (→ 0).
 */
async function grantCountsByRole(
	db: ReturnType<typeof getServiceDb>,
	orgId: string,
): Promise<Map<string, number>> {
	const rows = await db
		.select({
			roleId: grants.role_id,
			n: sql<number>`count(distinct case when ${grants.principal_type} = 'user' then ${grants.principal_id} end)`,
		})
		.from(grants)
		.where(and(eq(grants.org_id, orgId), isNotNull(grants.role_id)))
		.groupBy(grants.role_id);
	const map = new Map<string, number>();
	for (const r of rows) if (r.roleId) map.set(r.roleId, Number(r.n));
	return map;
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
		.select({ id: role.id, name: role.name, description: role.description })
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

/**
 * One round-trip of everything the Roles page needs beyond the searchable custom list: the
 * built-in roles (from the registry) with their grant counts, the permission catalog, the
 * Enterprise entitlement, and a non-throwing manage-permission check. Reading requires
 * `member:view` (throws ForbiddenError → the page renders a no-access notice).
 */
export async function getRolesBootstrap(): Promise<RolesBootstrap> {
	const actor = await authorizeQuiet("view", { type: "member" });
	const db = getServiceDb();
	const [counts, canManage] = await Promise.all([
		grantCountsByRole(db, actor.orgId),
		getPdp()
			.can(actor, "manage_members", { type: "member" })
			.then((d) => d.allowed),
	]);
	const builtin: RoleRow[] = ORDER.map((name) => ({
		id: BUILTIN_ROLE_IDS[name],
		name,
		description: BUILT_IN_ROLE_DESCRIPTIONS[name],
		builtin: true,
		permissionKeys: builtinKeys(name),
		grantCount: counts.get(BUILTIN_ROLE_IDS[name]) ?? 0,
	}));
	return {
		builtin,
		permissions: PERMISSIONS,
		customRoles: getEntitlements(actor).customRoles,
		canManage,
	};
}

/**
 * The active org's custom roles, filtered SERVER-SIDE by `search` over the role name,
 * description, or any of its permission keys (LIKE-escaped). Returns each role's permission
 * keys + distinct-user grant count. `member:view` gated.
 */
export async function listRoles(search?: string): Promise<RoleRow[]> {
	const actor = await authorizeQuiet("view", { type: "member" });
	const db = getServiceDb();
	const q = search?.trim();
	const like = q ? likeTerm(q) : null;

	const roles = await db
		.select({ id: role.id, name: role.name, description: role.description })
		.from(role)
		.where(
			and(
				eq(role.organization_id, actor.orgId),
				eq(role.is_builtin, false),
				like
					? or(
							sql`${role.name} ilike ${like}`,
							sql`${role.description} ilike ${like}`,
							exists(
								db
									.select({ one: sql`1` })
									.from(rolePermission)
									.where(
										and(
											eq(rolePermission.role_id, role.id),
											sql`${rolePermission.permission_key} ilike ${like}`,
										),
									),
							),
						)
					: undefined,
			),
		)
		.orderBy(asc(role.name));
	if (roles.length === 0) return [];

	const [perms, counts] = await Promise.all([
		db
			.select({ roleId: rolePermission.role_id, key: rolePermission.permission_key })
			.from(rolePermission)
			.where(inArray(rolePermission.role_id, roles.map((r) => r.id))),
		grantCountsByRole(db, actor.orgId),
	]);
	const byRole = new Map<string, string[]>();
	for (const p of perms) {
		const list = byRole.get(p.roleId) ?? [];
		list.push(p.key);
		byRole.set(p.roleId, list);
	}
	return roles.map((r) => ({
		id: r.id,
		name: r.name,
		description: r.description,
		builtin: false,
		permissionKeys: byRole.get(r.id) ?? [],
		grantCount: counts.get(r.id) ?? 0,
	}));
}

export async function createRole(
	name: string,
	permissionKeys: string[],
	description?: string,
): Promise<CustomRole> {
	const actor = await requireCustomRoles();
	const keys = sanitize(permissionKeys);
	const desc = description?.trim() || null;
	// Privilege ceiling: a role may never contain a permission its author doesn't hold, else an
	// admin could author (or, via updateRole, rewrite) a role to include billing/owner and escalate.
	if (!(await actorHoldsAllKeys(actor, keys))) {
		throw new ForbiddenError("manage_members", { type: "member" }, "role_exceeds_author_privilege");
	}
	const db = getServiceDb();
	const [created] = await db
		.insert(role)
		.values({ organization_id: actor.orgId, name, description: desc, is_builtin: false })
		.returning({ id: role.id, name: role.name, description: role.description });
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
	return {
		id: created.id,
		name: created.name,
		description: created.description,
		permissionKeys: keys,
	};
}

export async function updateRole(
	id: string,
	name: string,
	permissionKeys: string[],
	description?: string,
): Promise<void> {
	const actor = await requireCustomRoles();
	const keys = sanitize(permissionKeys);
	const desc = description?.trim() || null;
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

	await db.update(role).set({ name, description: desc }).where(eq(role.id, id));
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
