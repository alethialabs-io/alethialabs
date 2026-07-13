// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The privilege ceiling for delegation: a principal may only confer capabilities it itself
// holds. Shared by grants.ts (granting a role/permission) AND roles.ts (authoring a role's key
// set) so the ceiling can't be circumvented by mutating a role after granting it — otherwise an
// admin could create an empty role, self-grant it (vacuously within the ceiling), then rewrite it
// to include billing/owner permissions the admin lacks. Lives in lib/ (not a "use server" file) so
// both action modules can import it without Next.js treating it as a server action.

import { getPdp } from "@/lib/authz";
import {
	isPermissionKey,
	type PermissionDef,
	type PermissionKey,
	PERMISSIONS,
} from "@/lib/authz/registry";
import { rolePermissionKeys } from "@/lib/authz/role-permissions";
import type { Actor } from "@/lib/authz/types";

const PERMISSION_BY_KEY: ReadonlyMap<PermissionKey, PermissionDef> = new Map(
	PERMISSIONS.map((p): [PermissionKey, PermissionDef] => [p.key, p]),
);

/**
 * True iff `actor` effectively holds EVERY given permission key AS AN ORG-WIDE capability — the
 * ceiling test for delegation. Keys absent from the registry grant no capability and are skipped;
 * an empty set is trivially within the ceiling. Checked at org scope (no resource id) deliberately:
 * to confer a capability you must hold it org-wide. The only callers (owner/admin, who hold
 * `member:manage_members`) hold their roles org-wide, so this never over-denies a legitimate grantor.
 */
export async function actorHoldsAllKeys(
	actor: Actor,
	keys: readonly string[],
): Promise<boolean> {
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
 * True iff `actor` may grant the given role or single permission — its full expanded key set is
 * within the actor's own ceiling ({@link actorHoldsAllKeys}). Stops an admin (holds
 * `member:manage_members` but not billing) from granting the OWNER role, or any permission it lacks.
 */
export async function actorCanGrant(
	actor: Actor,
	roleId: string | null,
	permissionKey: string | null,
): Promise<boolean> {
	const keys = roleId
		? await rolePermissionKeys(roleId)
		: permissionKey
			? [permissionKey]
			: [];
	return actorHoldsAllKeys(actor, keys);
}
