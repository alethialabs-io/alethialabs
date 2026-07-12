"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { and, desc, eq } from "drizzle-orm";
import { getMembers } from "@/app/server/actions/members";
import { listCustomRoles } from "@/app/server/actions/roles";
import { recordActivity } from "@/lib/authz/activity";
import { emitAlertEventSafe } from "@/lib/alerts/emit";
import { getPdp } from "@/lib/authz";
import { getEntitlements } from "@/lib/authz/entitlements";
import { authorize } from "@/lib/authz/guard";
import {
	BUILTIN_ROLE_IDS,
	type BuiltInRole,
	isPermissionKey,
	type PermissionDef,
	type PermissionKey,
	PERMISSIONS,
} from "@/lib/authz/registry";
import { rolePermissionKeys } from "@/lib/authz/role-permissions";
import { getTupleSync } from "@/lib/authz/tuple-sync";
import type { Actor } from "@/lib/authz/types";
import { ForbiddenError } from "@/lib/authz/types";
import { getServiceDb } from "@/lib/db";
import {
	cloudIdentities,
	grants,
	role,
	runners,
	projects,
	team,
	user,
} from "@/lib/db/schema";

const VALID_KEYS: ReadonlySet<string> = new Set(PERMISSIONS.map((p) => p.key));

/** Every permission key → its (resource, action) split, for the privilege-ceiling check. */
const PERMISSION_BY_KEY: ReadonlyMap<PermissionKey, PermissionDef> = new Map(
	PERMISSIONS.map((p): [PermissionKey, PermissionDef] => [p.key, p]),
);

/**
 * Privilege-ceiling check (grill finding F1): an actor may only *delegate* (allow-grant) a role or
 * permission that is a SUBSET of what the actor themselves effectively holds. Without this, an
 * access-admin who holds `member:manage_members` but not billing (i.e. an admin) could self-grant the
 * OWNER role — which carries billing — and escalate; likewise for any single permission above their
 * ceiling.
 *
 * The target is expanded to its permission-key set (a role via its `role_permission` rows — built-in
 * or custom; a single permission to itself) and each key is checked against the actor's EFFECTIVE
 * permissions via the PDP at org scope (`getPdp().can`, no side-effects). "Effective permissions" are
 * exactly what the PDP grants the actor: an owner holds every permission (org-wide `*`) → passes every
 * key → may grant anything; an admin holds all-except-billing → the billing keys of the owner role
 * fail → admin→owner is denied, while admin→viewer (all keys ⊆ admin) is allowed. An empty target set
 * (a permissionless custom role) is trivially a subset ⇒ allowed. Keys absent from the registry grant
 * no capability and are skipped.
 *
 * Checked at org scope (no resource id) deliberately: delegation requires holding the capability as
 * an org-wide capability. The only principals who reach here (owner/admin — they hold
 * `member:manage_members`) hold their roles org-wide, so this never over-denies a legitimate grantor.
 */
async function actorCanGrant(
	actor: Actor,
	roleId: string | null,
	permissionKey: string | null,
): Promise<boolean> {
	const keys = roleId
		? await rolePermissionKeys(roleId)
		: permissionKey
			? [permissionKey]
			: [];
	const pdp = getPdp();
	for (const key of keys) {
		if (!isPermissionKey(key)) continue; // not a real permission → grants no capability
		const def = PERMISSION_BY_KEY.get(key);
		if (!def) continue;
		const decision = await pdp.can(actor, def.action, { type: def.resource });
		if (!decision.allowed) return false;
	}
	return true;
}

/**
 * Gate for mutating access grants. Enforces `member:manage_members` via the PDP FIRST
 * (a viewer/operator without it is denied and the denial is recorded), THEN the
 * Enterprise (customRoles) entitlement — mirroring the CLI route
 * (app/api/cli/grants). Both gates must pass; returns the resolved actor.
 */
async function requireAccessAdmin() {
	const actor = await authorize("manage_members", { type: "member" });
	if (!getEntitlements(actor).customRoles) {
		throw new Error("Access management requires an Enterprise license.");
	}
	return actor;
}

export interface GrantOption {
	id: string;
	label: string;
}
export interface GrantOptions {
	principals: { id: string; label: string; type: "user" | "team" }[];
	roles: { id: string; name: string; builtin: boolean }[];
	permissions: { key: string; resource: string; action: string }[];
	resources: Record<"project" | "runner" | "cloud_identity", GrantOption[]>;
}

/** Everything the "Grant access" builder needs, in one round-trip. */
export async function getGrantOptions(): Promise<GrantOptions> {
	// Reading the access model requires `member:view` (viewers keep parity; non-members
	// are denied) — mirrors the CLI GET /api/cli/grants gate.
	const actor = await authorize("view", { type: "member" });
	const db = getServiceDb();
	const [members, teamRows, projectRows, runnerRows, idRows, custom] =
		await Promise.all([
			getMembers(),
			db.select({ id: team.id, label: team.name }).from(team).where(eq(team.organizationId, actor.orgId)),
			db.select({ id: projects.id, label: projects.project_name }).from(projects).where(eq(projects.org_id, actor.orgId)),
			db.select({ id: runners.id, label: runners.name }).from(runners).where(eq(runners.org_id, actor.orgId)),
			db.select({ id: cloudIdentities.id, label: cloudIdentities.name }).from(cloudIdentities).where(eq(cloudIdentities.org_id, actor.orgId)),
			listCustomRoles(),
		]);

	const builtin = (Object.keys(BUILTIN_ROLE_IDS) as BuiltInRole[]).map((name) => ({
		id: BUILTIN_ROLE_IDS[name],
		name,
		builtin: true,
	}));

	return {
		principals: [
			...members.map((m) => ({
				id: m.userId,
				label: m.name ?? m.email,
				type: "user" as const,
			})),
			...teamRows.map((t) => ({ id: t.id, label: t.label, type: "team" as const })),
		],
		roles: [...builtin, ...custom.map((r) => ({ id: r.id, name: r.name, builtin: false }))],
		permissions: PERMISSIONS.map((p) => ({ key: p.key, resource: p.resource, action: p.action })),
		resources: { project: projectRows, runner: runnerRows, cloud_identity: idRows },
	};
}

export interface AssignGrantInput {
	principalType: "user" | "team";
	principalId: string;
	effect: "allow" | "deny";
	roleId?: string | null;
	permissionKey?: string | null;
	resourceType: string;
	resourceId?: string | null;
}

export async function assignGrant(input: AssignGrantInput): Promise<void> {
	const actor = await requireAccessAdmin();
	const hasRole = Boolean(input.roleId);
	const hasPerm = Boolean(input.permissionKey);
	if (hasRole === hasPerm) {
		throw new Error("Provide exactly one of a role or a single permission.");
	}
	if (input.permissionKey && !VALID_KEYS.has(input.permissionKey)) {
		throw new Error("Unknown permission.");
	}
	// Privilege ceiling: an allow-grant may not exceed the grantor's own effective permissions
	// (a deny-grant only removes access, so it can never escalate the grantee — skip it).
	if (
		input.effect === "allow" &&
		!(await actorCanGrant(actor, input.roleId ?? null, input.permissionKey ?? null))
	) {
		throw new ForbiddenError(
			"manage_members",
			{ type: "member" },
			"exceeds_grantor_privilege",
		);
	}
	const resourceId = input.resourceId ?? null;
	// Org-wide grants are stored on the org resource type.
	const resourceType = resourceId ? input.resourceType : "org";

	await getServiceDb()
		.insert(grants)
		.values({
			org_id: actor.orgId,
			principal_type: input.principalType,
			principal_id: input.principalId,
			effect: input.effect,
			role_id: input.roleId ?? null,
			permission_key: input.permissionKey ?? null,
			resource_type: resourceType,
			resource_id: resourceId,
		});

	void getTupleSync()
		.syncScopedGrant({
			orgId: actor.orgId,
			principalType: input.principalType,
			principalId: input.principalId,
			effect: input.effect,
			resourceType,
			resourceId,
			roleId: input.roleId ?? null,
			permissionKey: input.permissionKey ?? null,
		})
		.catch((err) => console.error("[authz] grant tuple sync failed:", err));

	// Security event: an access grant was assigned (gated to advancedAlerting in emit).
	emitAlertEventSafe(actor.orgId, "authz.grant.assign", {
		title: `Grant assigned: ${input.effect} ${input.permissionKey ?? "role"} on ${resourceType}`,
		severity: "warning",
		actor_id: actor.userId,
		action: "assign",
		resource_type: resourceType,
		resource_id: resourceId ?? undefined,
	});
	recordActivity(actor, "assign", { type: "grant" });
}

export async function revokeGrant(id: string): Promise<void> {
	const actor = await requireAccessAdmin();
	const db = getServiceDb();
	const [g] = await db
		.select()
		.from(grants)
		.where(and(eq(grants.id, id), eq(grants.org_id, actor.orgId)))
		.limit(1);
	if (!g) return;
	await db.delete(grants).where(and(eq(grants.id, id), eq(grants.org_id, actor.orgId)));

	void getTupleSync()
		.removeScopedGrant({
			orgId: g.org_id,
			principalType: g.principal_type === "team" ? "team" : "user",
			principalId: g.principal_id,
			effect: g.effect === "deny" ? "deny" : "allow",
			resourceType: g.resource_type,
			resourceId: g.resource_id,
			roleId: g.role_id,
			permissionKey: g.permission_key,
		})
		.catch((err) => console.error("[authz] grant tuple removal failed:", err));

	// Security event: an access grant was revoked (gated to advancedAlerting in emit).
	emitAlertEventSafe(actor.orgId, "authz.grant.revoke", {
		title: `Grant revoked: ${g.effect} ${g.permission_key ?? "role"} on ${g.resource_type}`,
		severity: "warning",
		actor_id: actor.userId,
		action: "revoke",
		resource_type: g.resource_type,
		resource_id: g.resource_id ?? undefined,
	});
	recordActivity(actor, "revoke", { type: "grant" });
}

export interface AccessGrantRow {
	id: string;
	principalType: string;
	principalId: string;
	principalLabel: string;
	effect: "allow" | "deny";
	roleName: string | null;
	permissionKey: string | null;
	resourceType: string;
	resourceId: string | null;
	createdAt: string;
}

/**
 * Every grant in the active org, enriched for the Access table. When `projectId` is given the list
 * is scoped to grants bound to that project (`resource_type = "project"` and `resource_id`), for the
 * project-scoped Access surface; without it, every org grant is returned.
 */
export async function listAccessGrants(projectId?: string): Promise<AccessGrantRow[]> {
	// Enumerating grants requires `member:view` (viewers keep parity; non-members are
	// denied) — mirrors the CLI GET /api/cli/grants gate.
	const actor = await authorize("view", { type: "member" });
	const rows = await getServiceDb()
		.select({
			id: grants.id,
			principalType: grants.principal_type,
			principalId: grants.principal_id,
			principalName: user.name,
			principalEmail: user.email,
			effect: grants.effect,
			roleName: role.name,
			permissionKey: grants.permission_key,
			resourceType: grants.resource_type,
			resourceId: grants.resource_id,
			createdAt: grants.created_at,
		})
		.from(grants)
		.leftJoin(user, eq(grants.principal_id, user.id))
		.leftJoin(role, eq(grants.role_id, role.id))
		.where(
			projectId
				? and(
						eq(grants.org_id, actor.orgId),
						eq(grants.resource_type, "project"),
						eq(grants.resource_id, projectId),
					)
				: eq(grants.org_id, actor.orgId),
		)
		.orderBy(desc(grants.created_at));

	return rows.map((r) => ({
		id: r.id,
		principalType: r.principalType,
		principalId: r.principalId,
		principalLabel: r.principalName ?? r.principalEmail ?? `${r.principalId.slice(0, 8)}…`,
		effect: r.effect === "deny" ? "deny" : "allow",
		roleName: r.roleName,
		permissionKey: r.permissionKey,
		resourceType: r.resourceType,
		resourceId: r.resourceId,
		createdAt: r.createdAt.toISOString(),
	}));
}
