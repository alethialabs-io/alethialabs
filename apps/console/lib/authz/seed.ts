// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { notInArray, sql } from "drizzle-orm";
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

	// One-time rename of registry permission keys (audit:* → activity:*): move existing
	// custom grants + role-permissions onto the new keys BEFORE the prune below
	// cascade-deletes the renamed (now-absent) keys, so no access is lost. Idempotent —
	// no rows match once migrated.
	const KEY_RENAMES: [string, string][] = [
		["audit:view_audit", "activity:view_activity"],
		["audit:export_audit", "activity:export_activity"],
	];
	for (const [oldKey, newKey] of KEY_RENAMES) {
		// grants.id is the PK, so permission_key isn't unique — a plain UPDATE is safe.
		await db.execute(
			sql`update grants set permission_key = ${newKey} where permission_key = ${oldKey}`,
		);
		// role_permission PK is (role_id, permission_key): only move rows whose role
		// doesn't already hold the new key (built-in roles were re-seeded above with the
		// new key; their old-key rows fall to the prune's cascade).
		await db.execute(sql`
			update role_permission rp set permission_key = ${newKey}
			where rp.permission_key = ${oldKey}
			  and not exists (
				select 1 from role_permission x
				where x.role_id = rp.role_id and x.permission_key = ${newKey}
			  )
		`);
	}

	// Prune permissions no longer in the registry (e.g. renamed actions) so the DB
	// never drifts from registry.ts. ON DELETE CASCADE on role_permission.permission_key
	// and grants.permission_key removes any rows referencing the dropped key.
	if (allKeys.length > 0) {
		await db.delete(permission).where(notInArray(permission.key, allKeys));
	}

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
