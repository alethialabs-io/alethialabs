"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { and, desc, eq } from "drizzle-orm";
import { getMembers } from "@/app/server/actions/members";
import { listCustomRoles } from "@/app/server/actions/roles";
import { emitAlertEventSafe } from "@/lib/alerts/emit";
import { getEntitlements } from "@/lib/authz/entitlements";
import { currentActor } from "@/lib/authz/guard";
import {
	BUILTIN_ROLE_IDS,
	type BuiltInRole,
	PERMISSIONS,
} from "@/lib/authz/registry";
import { getTupleSync } from "@/lib/authz/tuple-sync";
import { getServiceDb } from "@/lib/db";
import {
	cloudIdentities,
	grants,
	role,
	runners,
	specs,
	team,
	user,
	zones,
} from "@/lib/db/schema";

const VALID_KEYS: ReadonlySet<string> = new Set(PERMISSIONS.map((p) => p.key));

/** Managing access (grants) is an Enterprise feature; enforce it server-side. */
async function requireAccessAdmin() {
	const actor = await currentActor();
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
	resources: Record<"zone" | "spec" | "runner" | "cloud_identity", GrantOption[]>;
}

/** Everything the "Grant access" builder needs, in one round-trip. */
export async function getGrantOptions(): Promise<GrantOptions> {
	const actor = await currentActor();
	const db = getServiceDb();
	const [members, teamRows, zoneRows, specRows, runnerRows, idRows, custom] =
		await Promise.all([
			getMembers(),
			db.select({ id: team.id, label: team.name }).from(team).where(eq(team.organizationId, actor.orgId)),
			db.select({ id: zones.id, label: zones.name }).from(zones).where(eq(zones.org_id, actor.orgId)),
			db.select({ id: specs.id, label: specs.project_name }).from(specs).where(eq(specs.org_id, actor.orgId)),
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
		resources: { zone: zoneRows, spec: specRows, runner: runnerRows, cloud_identity: idRows },
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

/** Every grant in the active org, enriched for the Access table. */
export async function listAccessGrants(): Promise<AccessGrantRow[]> {
	const actor = await currentActor();
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
		.where(eq(grants.org_id, actor.orgId))
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
