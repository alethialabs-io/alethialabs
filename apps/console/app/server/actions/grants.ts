"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// WRITES, plus one orphaned read (ADR 0005 D1/D4, #6129). The Access page's reads — the grants page
// and the builder's options — moved to `lib/rpc/procedures/members.ts` and are served over GET.
// `assignGrant` and `revokeGrant` are `defineAction`s returning `ActionResult<T>`; every check they
// made as plain actions (the PDP gate, the entitlement, the org binding, the privilege ceiling, the
// active-membership refusal) runs in the same order inside them.

import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { defineAction } from "@/lib/actions/define-action";
import { ActionRefusal, type ActionResult } from "@/lib/actions/result";
import { recordActivity } from "@/lib/authz/activity";
import { emitAlertEventSafe } from "@/lib/alerts/emit";
import { actorCanGrant } from "@/lib/authz/ceiling";
import { grantBindingViolation } from "@/lib/authz/grant-binding";
import { getEntitlements } from "@/lib/authz/entitlements";
import { grantScopeFromRow, parseGrantResource } from "@/lib/authz/fga-tuples";
import { INACTIVE_PRINCIPAL_MESSAGE, lacksActiveMembership } from "@/lib/authz/grants";
import { resourceIdOf } from "@/lib/authz/grant-scope";
import { authorize } from "@/lib/authz/guard";
import { PERMISSIONS } from "@/lib/authz/registry";
import { getTupleSync } from "@/lib/authz/tuple-sync";
import { ForbiddenError } from "@/lib/authz/types";
import { getServiceDb } from "@/lib/db";
import { grants, role, user } from "@/lib/db/schema";

const VALID_KEYS: ReadonlySet<string> = new Set(PERMISSIONS.map((p) => p.key));

/**
 * Gate for mutating access grants. Enforces `member:manage_members` via the PDP FIRST
 * (a viewer/operator without it is denied and the denial is recorded), THEN the
 * Enterprise (customRoles) entitlement — mirroring the CLI route
 * (app/api/cli/grants). Both gates must pass; returns the resolved actor.
 */
async function requireAccessAdmin() {
	const actor = await authorize("manage_members", { type: "member" });
	if (!getEntitlements(actor).customRoles) {
		throw new ActionRefusal(
			"entitlement",
			"Access management requires an Enterprise license.",
			"customRoles",
		);
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

export interface AssignGrantInput {
	principalType: "user" | "team";
	principalId: string;
	effect: "allow" | "deny";
	roleId?: string | null;
	permissionKey?: string | null;
	/**
	 * The kind half of the scope. Typed `string` and not `GrantResourceType` DELIBERATELY: a
	 * server action's arguments arrive over the wire from a client bundle, so a union here would
	 * be a claim the compiler cannot keep. `assignGrant` parses it with `parseGrantResource`
	 * instead, which is the only place the check can be true — and the only way to obtain the
	 * `GrantResource` that the insert and `syncScopedGrant` are built from.
	 */
	resourceType: string;
	resourceId?: string | null;
}

/**
 * The runtime shape of {@link AssignGrantInput}. A server action's argument arrives over the wire,
 * so the TypeScript type is a claim, not a check: before this, a request that OMITTED `effect`
 * skipped both the privilege ceiling and the active-member check (each tests `effect === "allow"`)
 * while the insert fell back to the column default, `allow` (#5478 review). `effect` and
 * `principalType` are required enums here, so an omitted or unknown value is refused.
 */
const assignGrantInputSchema = z.object({
	principalType: z.enum(["user", "team"]),
	principalId: z.string().min(1),
	effect: z.enum(["allow", "deny"]),
	roleId: z.string().nullish(),
	permissionKey: z.string().nullish(),
	resourceType: z.string(),
	resourceId: z.string().nullish(),
});

/**
 * Writes one access grant, after refusing every request it cannot store faithfully: a malformed
 * request (no `effect`, an unknown `principalType`, …; a `validation` result, decided from the
 * request alone before the PDP is asked), then — in this order, inside `writeGrant` — a caller
 * without `member:manage_members` or the Enterprise entitlement, a role-and-permission pair (or
 * neither), an unknown permission key, the org kind carrying a resource id, an unrecognised
 * resource kind, an allow-grant that exceeds the grantor's own permissions, and an allow-grant to a
 * user without an ACTIVE member row in the org — suspended, removed, or never a member (#5472) — and
 * a role, team principal or scoped resource that is not this org's (a `ForbiddenError` whose reason
 * is the `GrantBindingReason`). Then syncs the grant's PDP tuples and records
 * the security event.
 */
export async function assignGrant(
	raw: z.input<typeof assignGrantInputSchema>,
): Promise<ActionResult<{ assigned: true }>> {
	return defineAction({
		input: assignGrantInputSchema,
		run: async ({ input }) => {
			await writeGrant(input);
			return { assigned: true as const };
		},
	})(raw);
}

/** The body of {@link assignGrant}, on input whose SHAPE is already checked. */
async function writeGrant(input: AssignGrantInput): Promise<void> {
	const actor = await requireAccessAdmin();
	const hasRole = Boolean(input.roleId);
	const hasPerm = Boolean(input.permissionKey);
	if (hasRole === hasPerm) {
		throw new ActionRefusal("conflict", "Provide exactly one of a role or a single permission.");
	}
	if (input.permissionKey && !VALID_KEYS.has(input.permissionKey)) {
		throw new ActionRefusal("conflict", "Unknown permission.");
	}
	// The org kind with an id, an unrecognised kind (#4734) and an empty id are all refused here,
	// and what comes back is the typed scope everything below is built from — so there is no
	// second derivation of the kind from the id to launder one of those into an org-wide grant.
	const parsed = parseGrantResource(input.resourceType, input.resourceId ?? null);
	if (!parsed.ok) throw new ActionRefusal("conflict", parsed.error);
	const scope = parsed.resource;
	// Everything the grant references belongs to THIS org (or is a built-in role): the role, a team
	// principal, and the scoped resource. Checked before the ceiling, so a role of another org is
	// refused for what it is rather than evaluated. The `grants_org_binding` trigger is the backstop
	// for the same predicate; this is what turns it into a named refusal (lib/authz/grant-binding.ts).
	const unbound = await grantBindingViolation({
		orgId: actor.orgId,
		principalType: input.principalType,
		principalId: input.principalId,
		roleId: input.roleId ?? null,
		resource: scope,
	});
	if (unbound !== null) {
		throw new ForbiddenError("manage_members", { type: "member" }, unbound);
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
	// A user who is not an active member of the org (suspended, removed, or never a member) gets no
	// allow grant: the member lifecycle refuses it in `ensureMemberGrant`, and this API must not be
	// the way around that. A grant planted for a non-member would become live if they later joined.
	if (
		input.effect === "allow" &&
		input.principalType === "user" &&
		(await lacksActiveMembership(actor.orgId, input.principalId))
	) {
		throw new ActionRefusal("conflict", INACTIVE_PRINCIPAL_MESSAGE);
	}
	const resourceId = resourceIdOf(scope);
	const resourceType = scope.resourceType;

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
			...scope,
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

const revokeGrantInput = z.object({ id: z.string().uuid() });

/**
 * Revokes one of the addressed org's grants and removes its PDP tuples. A grant of another org, or
 * one already gone, is a no-op: the select and the delete are both on `org_id = actor.orgId`.
 */
export async function revokeGrant(
	raw: z.input<typeof revokeGrantInput>,
): Promise<ActionResult<{ id: string }>> {
	return defineAction({
		input: revokeGrantInput,
		run: async ({ input }) => {
			await deleteGrant(input.id);
			return { id: input.id };
		},
	})(raw);
}

/** The body of {@link revokeGrant}, on validated input. */
async function deleteGrant(id: string): Promise<void> {
	const actor = await requireAccessAdmin();
	const db = getServiceDb();
	const [g] = await db
		.select()
		.from(grants)
		.where(and(eq(grants.id, id), eq(grants.org_id, actor.orgId)))
		.limit(1);
	if (!g) return;
	await db.delete(grants).where(and(eq(grants.id, id), eq(grants.org_id, actor.orgId)));

	// The row is raw columns, so it is narrowed rather than spread into a `ScopedGrant`. A null
	// scope is an ALLOW row that confers nothing (the #4584 ruling, via `targetForEffect`); it has
	// no object to clear, which is what ee's writer already did for it (a no-op).
	const scope = grantScopeFromRow({
		orgId: g.org_id,
		principalType: g.principal_type === "team" ? "team" : "user",
		principalId: g.principal_id,
		effect: g.effect === "deny" ? "deny" : "allow",
		resourceType: g.resource_type,
		resourceId: g.resource_id,
	});
	if (scope !== null) {
		void getTupleSync()
			.removeScopedGrant({ ...scope, roleId: g.role_id, permissionKey: g.permission_key })
			.catch((err) => console.error("[authz] grant tuple removal failed:", err));
	}

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
