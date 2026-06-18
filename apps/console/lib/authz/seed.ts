// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { sql } from "drizzle-orm";
import { getServiceDb } from "@/lib/db";
import { permission, role, rolePermission } from "@/lib/db/schema";
import {
	BUILT_IN_ROLES,
	BUILTIN_ROLE_IDS,
	type BuiltInRole,
	PERMISSIONS,
} from "@/lib/authz/registry";

let seeded = false;

/**
 * Idempotently syncs the static authz registry (permissions + built-in roles +
 * their permission grants) from registry.ts into the DB. Run once per app instance
 * at boot (instrumentation.ts) so editing the registry auto-propagates on deploy.
 * Built-in roles use fixed ids → upsert-by-PK; everything is onConflictDoNothing.
 */
export async function seedAuthz(): Promise<void> {
	if (seeded) return;
	if (!process.env.ALETHIA_DATABASE_URL) return; // no DB configured yet
	seeded = true;

	const db = getServiceDb();
	const roleNames = Object.keys(BUILT_IN_ROLES) as BuiltInRole[];
	const allKeys = PERMISSIONS.map((p) => p.key);

	await db
		.insert(permission)
		.values(
			PERMISSIONS.map((p) => ({
				key: p.key,
				resource: p.resource,
				action: p.action,
				description: p.description,
			})),
		)
		.onConflictDoNothing();

	await db
		.insert(role)
		.values(
			roleNames.map((name) => ({
				id: BUILTIN_ROLE_IDS[name],
				organization_id: null,
				name,
				is_builtin: true,
			})),
		)
		.onConflictDoNothing();

	const rolePerms = roleNames.flatMap((name) => {
		const grant = BUILT_IN_ROLES[name];
		const keys = grant === "*" ? allKeys : grant;
		return keys.map((permission_key) => ({
			role_id: BUILTIN_ROLE_IDS[name],
			permission_key,
		}));
	});

	await db.insert(rolePermission).values(rolePerms).onConflictDoNothing();

	// Backfill: every existing user owns their personal org (org-wide owner grant).
	// New users get this in the Better Auth user-create hook (lib/auth/index.ts).
	await db.execute(sql`
		insert into grants (org_id, principal_type, principal_id, role_id, resource_type)
		select u.id, 'user', u.id, ${BUILTIN_ROLE_IDS.owner}::uuid, 'org'
		from "user" u
		where not exists (
			select 1 from grants g
			where g.org_id = u.id and g.principal_id = u.id
			  and g.role_id = ${BUILTIN_ROLE_IDS.owner}::uuid and g.resource_type = 'org'
		)
	`);
}
