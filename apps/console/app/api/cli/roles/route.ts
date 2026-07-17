// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { typedKeys } from "@/lib/typed-object";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { emitAlertEventSafe } from "@/lib/alerts/emit";
import { authorizeCli } from "@/lib/authz/guard";
import { getEntitlements } from "@/lib/authz/entitlements";
import { recordActivity } from "@/lib/authz/activity";
import {
	BUILTIN_ROLE_IDS,
	type BuiltInRole,
	BUILT_IN_ROLE_DESCRIPTIONS,
	BUILT_IN_ROLES,
	PERMISSIONS,
} from "@/lib/authz/registry";
import { getServiceDb } from "@/lib/db";
import { role, rolePermission } from "@/lib/db/schema";
import { NextResponse } from "next/server";
import { cliJson } from "@/lib/cli/respond";
import {
	cliRoleResponse,
	cliRolesResponse,
} from "@/lib/validations/cli-contract";

/** Body of POST /api/cli/roles — a named custom role plus its permission keys. */
const createRoleBody = z.object({
	name: z.string().min(1).max(120),
	permission_keys: z.array(z.string()).default([]),
});

/** Every registered permission key — the allow-list custom roles are filtered to. */
const ALL_KEYS = PERMISSIONS.map((p) => p.key);
const VALID_KEYS: ReadonlySet<string> = new Set(ALL_KEYS);

/** Keep only known, de-duplicated permission keys (no unsafe input reaches the DB). */
function sanitize(keys: string[]): string[] {
	return [...new Set(keys.filter((k) => VALID_KEYS.has(k)))];
}

/** The built-in role templates as CLI wire shapes (`"*"` expands to every key). */
function builtinRoleWires() {
	return typedKeys(BUILTIN_ROLE_IDS).map((name) => {
		const keys = BUILT_IN_ROLES[name];
		return {
			id: BUILTIN_ROLE_IDS[name],
			name,
			description: BUILT_IN_ROLE_DESCRIPTIONS[name],
			is_builtin: true,
			permission_keys: keys === "*" ? ALL_KEYS : keys,
		};
	});
}

/**
 * Lists the active org's roles: the four built-in templates (flagged is_builtin,
 * with their resolved permission keys) followed by the org's custom roles. Scoped by
 * org_id, gated on `view` of `member` (access administration). Mirrors listCustomRoles.
 */
export async function GET(req: Request) {
	const auth = await authorizeCli(req, "view", { type: "member" });
	if ("error" in auth) return auth.error;
	const { actor } = auth;

	try {
		const db = getServiceDb();
		const custom = await db
			.select({ id: role.id, name: role.name, description: role.description })
			.from(role)
			.where(and(eq(role.organization_id, actor.orgId), eq(role.is_builtin, false)));

		const byRole = new Map<string, string[]>();
		if (custom.length > 0) {
			const perms = await db
				.select({ roleId: rolePermission.role_id, key: rolePermission.permission_key })
				.from(rolePermission)
				.where(inArray(rolePermission.role_id, custom.map((r) => r.id)));
			for (const p of perms) {
				const list = byRole.get(p.roleId) ?? [];
				list.push(p.key);
				byRole.set(p.roleId, list);
			}
		}

		const customWires = custom.map((r) => ({
			id: r.id,
			name: r.name,
			description: r.description,
			is_builtin: false,
			permission_keys: byRole.get(r.id) ?? [],
		}));

		return cliJson(cliRolesResponse, {
			roles: [...builtinRoleWires(), ...customWires],
		});
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}

/** Creates a custom role with its permission keys (mirrors the createRole action).
 * Authoring custom roles is an Enterprise capability — gated on the customRoles
 * entitlement. Gated on `manage_members` of `member`. */
export async function POST(req: Request) {
	const auth = await authorizeCli(req, "manage_members", { type: "member" });
	if ("error" in auth) return auth.error;
	const { actor } = auth;

	if (!getEntitlements(actor).customRoles) {
		return NextResponse.json(
			{ error: "Custom roles require an Enterprise license." },
			{ status: 402 },
		);
	}

	const parsed = createRoleBody.safeParse(await req.json().catch(() => null));
	if (!parsed.success) {
		return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
	}
	const keys = sanitize(parsed.data.permission_keys);

	try {
		const db = getServiceDb();
		const [created] = await db
			.insert(role)
			.values({ organization_id: actor.orgId, name: parsed.data.name, is_builtin: false })
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

		return cliJson(
			cliRoleResponse,
			{
				role: {
					id: created.id,
					name: created.name,
					description: null,
					is_builtin: false,
					permission_keys: keys,
				},
			},
			{ status: 201 },
		);
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
