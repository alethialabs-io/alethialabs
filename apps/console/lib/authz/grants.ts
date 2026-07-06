// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Bridges Better Auth organization membership (the `member` row + `member.role`) to
// the PDP's authorization model (the `grants` table). The PDP authorizes from grants,
// NOT from member.role — so every org-membership change must sync a matching org-wide
// grant, or an invited member would have a row but no access. The ee/ organization
// plugin's member-lifecycle hooks call these via CoreContext (so ee/ never imports
// core internals). Membership roles == the PDP roles (owner/admin/operator/viewer),
// see lib/authz/org-access-control.ts.

import { sql } from "drizzle-orm";
import { toOrgRole } from "@/lib/authz/org-access-control";
import { BUILTIN_ROLE_IDS } from "@/lib/authz/registry";
import { getTupleSync } from "@/lib/authz/tuple-sync";
import { getServiceDb } from "@/lib/db";

/** Mirror a grant change to OpenFGA, best-effort (Postgres is the source of truth). */
function mirror(run: Promise<void>): void {
	void run.catch((err) => console.error("[authz] tuple sync failed:", err));
}

/**
 * Sets a member's org-wide PDP grant to `role` (so the PDP authorizes them within
 * the org). Idempotent SET semantics — replaces any existing org-scope grant for the
 * user — so it's safe whether it fires on add, role-change, or a double event. A role
 * outside the built-in set is ignored (no grant written).
 */
export async function ensureMemberGrant(
	orgId: string,
	userId: string,
	role: string,
): Promise<void> {
	const resolved = toOrgRole(role);
	if (!resolved) return;
	const roleId = BUILTIN_ROLE_IDS[resolved];
	const db = getServiceDb();
	await db.execute(sql`
		delete from grants
		where org_id = ${orgId}::uuid and principal_type = 'user'
		  and principal_id = ${userId}::uuid
		  and resource_type = 'org' and resource_id is null
	`);
	await db.execute(sql`
		insert into grants (org_id, principal_type, principal_id, role_id, resource_type)
		values (${orgId}::uuid, 'user', ${userId}::uuid, ${roleId}::uuid, 'org')
	`);
	mirror(getTupleSync().syncMemberGrant(orgId, userId, resolved));
}

/**
 * Revokes ALL of a user's grants in an org (org-wide + any scoped) — on removal from
 * the organization, their access goes with them.
 */
export async function revokeMemberGrant(
	orgId: string,
	userId: string,
): Promise<void> {
	await getServiceDb().execute(sql`
		delete from grants
		where org_id = ${orgId}::uuid and principal_type = 'user'
		  and principal_id = ${userId}::uuid
	`);
	mirror(getTupleSync().revokeMemberGrant(orgId, userId));
}
