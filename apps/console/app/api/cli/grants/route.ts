// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { emitAlertEventSafe } from "@/lib/alerts/emit";
import { getPdp } from "@/lib/authz";
import { authorizeCli } from "@/lib/authz/guard";
import { getEntitlements } from "@/lib/authz/entitlements";
import { recordActivity } from "@/lib/authz/activity";
import {
	isPermissionKey,
	type PermissionDef,
	type PermissionKey,
	PERMISSIONS,
} from "@/lib/authz/registry";
import { rolePermissionKeys } from "@/lib/authz/role-permissions";
import { getTupleSync } from "@/lib/authz/tuple-sync";
import type { Actor } from "@/lib/authz/types";
import { getServiceDb } from "@/lib/db";
import { grants, role } from "@/lib/db/schema";
import { NextResponse } from "next/server";
import { cliJson } from "@/lib/cli/respond";
import {
	cliGrantResponse,
	cliGrantsResponse,
} from "@/lib/validations/cli-contract";

const VALID_KEYS: ReadonlySet<string> = new Set(PERMISSIONS.map((p) => p.key));

/** Every permission key → its (resource, action) split, for the privilege-ceiling check. */
const PERMISSION_BY_KEY: ReadonlyMap<PermissionKey, PermissionDef> = new Map(
	PERMISSIONS.map((p): [PermissionKey, PermissionDef] => [p.key, p]),
);

/**
 * Privilege-ceiling check (grill finding F1) — the CLI mirror of assignGrant's `actorCanGrant`. An
 * allow-grant may only delegate a role/permission the actor themselves effectively holds, so an admin
 * (who holds `member:manage_members` but not billing) can't self-grant the OWNER role and escalate.
 * The target is expanded to its permission-key set and each key is checked against the actor's
 * effective permissions via the PDP at org scope (no side-effects). Empty set ⇒ allowed.
 */
async function callerCanGrant(
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
		if (!isPermissionKey(key)) continue;
		const def = PERMISSION_BY_KEY.get(key);
		if (!def) continue;
		const decision = await pdp.can(actor, def.action, { type: def.resource });
		if (!decision.allowed) return false;
	}
	return true;
}

/** Body of POST /api/cli/grants — bind a principal to EXACTLY one of a role or a
 * single permission, at a resource scope, as allow or deny. resource_id omitted =
 * org-wide. */
const createGrantBody = z.object({
	principal_type: z.enum(["user", "team"]),
	principal_id: z.uuid(),
	effect: z.enum(["allow", "deny"]).default("allow"),
	role_id: z.uuid().nullable().optional(),
	permission_key: z.string().nullable().optional(),
	resource_type: z.string().min(1).default("org"),
	resource_id: z.uuid().nullable().optional(),
});

/** Shape of a grant on the CLI wire (the grant row + its bound role's name). */
function toGrantWire(
	row: typeof grants.$inferSelect,
	roleName: string | null,
) {
	return {
		id: row.id,
		principal_type: row.principal_type,
		principal_id: row.principal_id,
		effect: row.effect,
		role: roleName,
		permission_key: row.permission_key,
		resource_type: row.resource_type,
		resource_id: row.resource_id,
	};
}

/** Lists the active org's access grants, joined to their bound role's name, newest
 * first. Scoped by org_id, gated on `view` of `member` (access administration). */
export async function GET(req: Request) {
	const auth = await authorizeCli(req, "view", { type: "member" });
	if ("error" in auth) return auth.error;
	const { actor } = auth;

	try {
		const rows = await getServiceDb()
			.select({
				id: grants.id,
				principal_type: grants.principal_type,
				principal_id: grants.principal_id,
				effect: grants.effect,
				role_name: role.name,
				permission_key: grants.permission_key,
				resource_type: grants.resource_type,
				resource_id: grants.resource_id,
			})
			.from(grants)
			.leftJoin(role, eq(grants.role_id, role.id))
			.where(eq(grants.org_id, actor.orgId))
			.orderBy(desc(grants.created_at));

		const grantWires = rows.map((r) => ({
			id: r.id,
			principal_type: r.principal_type,
			principal_id: r.principal_id,
			effect: r.effect,
			role: r.role_name ?? null,
			permission_key: r.permission_key ?? null,
			resource_type: r.resource_type,
			resource_id: r.resource_id ?? null,
		}));

		return cliJson(cliGrantsResponse, { grants: grantWires });
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}

/** Assigns an access grant (mirrors the assignGrant action) and syncs its PDP
 * tuples. Access management is an Enterprise capability — gated on customRoles.
 * Gated on `manage_members` of `member`. */
export async function POST(req: Request) {
	const auth = await authorizeCli(req, "manage_members", { type: "member" });
	if ("error" in auth) return auth.error;
	const { actor } = auth;

	if (!getEntitlements(actor).customRoles) {
		return NextResponse.json(
			{ error: "Access management requires an Enterprise license." },
			{ status: 402 },
		);
	}

	const parsed = createGrantBody.safeParse(await req.json().catch(() => null));
	if (!parsed.success) {
		return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
	}
	const input = parsed.data;

	const hasRole = Boolean(input.role_id);
	const hasPerm = Boolean(input.permission_key);
	if (hasRole === hasPerm) {
		return NextResponse.json(
			{ error: "Provide exactly one of a role or a single permission." },
			{ status: 400 },
		);
	}
	if (input.permission_key && !VALID_KEYS.has(input.permission_key)) {
		return NextResponse.json({ error: "Unknown permission." }, { status: 400 });
	}
	// Privilege ceiling: an allow-grant may not exceed the caller's own effective permissions
	// (a deny only removes access, so it can't escalate the grantee — skip it).
	if (
		input.effect === "allow" &&
		!(await callerCanGrant(actor, input.role_id ?? null, input.permission_key ?? null))
	) {
		return NextResponse.json(
			{ error: "A grant may not exceed your own permissions." },
			{ status: 403 },
		);
	}

	const resourceId = input.resource_id ?? null;
	// Org-wide grants are stored on the org resource type.
	const resourceType = resourceId ? input.resource_type : "org";

	try {
		const db = getServiceDb();
		const [created] = await db
			.insert(grants)
			.values({
				org_id: actor.orgId,
				principal_type: input.principal_type,
				principal_id: input.principal_id,
				effect: input.effect,
				role_id: input.role_id ?? null,
				permission_key: input.permission_key ?? null,
				resource_type: resourceType,
				resource_id: resourceId,
			})
			.returning();

		let roleName: string | null = null;
		if (created.role_id) {
			const [r] = await db
				.select({ name: role.name })
				.from(role)
				.where(eq(role.id, created.role_id))
				.limit(1);
			roleName = r?.name ?? null;
		}

		void getTupleSync()
			.syncScopedGrant({
				orgId: actor.orgId,
				principalType: input.principal_type,
				principalId: input.principal_id,
				effect: input.effect,
				resourceType,
				resourceId,
				roleId: input.role_id ?? null,
				permissionKey: input.permission_key ?? null,
			})
			.catch((err) => console.error("[authz] grant tuple sync failed:", err));

		emitAlertEventSafe(actor.orgId, "authz.grant.assign", {
			title: `Grant assigned: ${input.effect} ${input.permission_key ?? "role"} on ${resourceType}`,
			severity: "warning",
			actor_id: actor.userId,
			action: "assign",
			resource_type: resourceType,
			resource_id: resourceId ?? undefined,
		});
		recordActivity(actor, "assign", { type: "grant", id: created.id });

		return cliJson(
			cliGrantResponse,
			{ grant: toGrantWire(created, roleName) },
			{ status: 201 },
		);
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
