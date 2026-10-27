"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// WRITES ONLY (ADR 0005 D1/D4, #6129). The role reads (the catalog, the custom-role list) moved to
// `lib/rpc/procedures/members.ts` and are served over GET; every export here is a `defineAction`
// returning `ActionResult<T>`. The row types stay here: the procedures and the page shape with them.

import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { defineAction } from "@/lib/actions/define-action";
import { ActionRefusal, type ActionResult } from "@/lib/actions/result";
import { recordActivity } from "@/lib/authz/activity";
import { emitAlertEventSafe } from "@/lib/alerts/emit";
import { actorHoldsAllKeys } from "@/lib/authz/ceiling";
import { getEntitlements } from "@/lib/authz/entitlements";
import { authorizeQuiet } from "@/lib/authz/guard";
import { type PermissionDef, PERMISSIONS } from "@/lib/authz/registry";
import { getTupleSync } from "@/lib/authz/tuple-sync";
import type { Actor } from "@/lib/authz/types";
import { ForbiddenError } from "@/lib/authz/types";
import { getServiceDb } from "@/lib/db";
import { role, rolePermission } from "@/lib/db/schema";

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
		throw new ActionRefusal("entitlement", "Custom roles require an Enterprise license.", "customRoles");
	}
	return actor;
}

/**
 * A role's editable fields as they arrive over the wire. The shape is checked here; the permission
 * keys are then `sanitize`d against the registry, so an unknown key never reaches the database.
 */
const roleFields = {
	name: z.string().trim().min(1, "Name your role").max(120),
	permissionKeys: z.array(z.string().max(200)).max(500),
	description: z.string().max(500).optional(),
};

const createRoleInput = z.object(roleFields);
const updateRoleInput = z.object({ id: z.string().uuid(), ...roleFields });
const deleteRoleInput = z.object({ id: z.string().uuid() });

/** Creates a custom role in the addressed org. Gated by {@link requireCustomRoles} and the ceiling. */
export async function createRole(
	raw: z.input<typeof createRoleInput>,
): Promise<ActionResult<CustomRole>> {
	return defineAction({
		input: createRoleInput,
		run: ({ input }) => insertRole(input.name, input.permissionKeys, input.description),
	})(raw);
}

/** The body of {@link createRole}, on validated input. */
async function insertRole(
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

/** Rewrites one of the addressed org's custom roles. Gated like {@link createRole}. */
export async function updateRole(
	raw: z.input<typeof updateRoleInput>,
): Promise<ActionResult<{ id: string }>> {
	return defineAction({
		input: updateRoleInput,
		run: async ({ input }) => {
			await rewriteRole(input.id, input.name, input.permissionKeys, input.description);
			return { id: input.id };
		},
	})(raw);
}

/** The body of {@link updateRole}, on validated input. */
async function rewriteRole(
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
	// Only this org's non-built-in roles may be edited; another org's role reads as not found.
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
	if (!target) throw new ActionRefusal("not-found", "Role not found.");

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

/** Deletes one of the addressed org's custom roles. Gated like {@link createRole}. */
export async function deleteRole(
	raw: z.input<typeof deleteRoleInput>,
): Promise<ActionResult<{ id: string }>> {
	return defineAction({
		input: deleteRoleInput,
		run: async ({ input }) => {
			await removeRole(input.id);
			return { id: input.id };
		},
	})(raw);
}

/** The body of {@link deleteRole}, on validated input. */
async function removeRole(id: string): Promise<void> {
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
