// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

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
}
