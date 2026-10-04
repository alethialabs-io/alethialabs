// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Bridges Better Auth organization membership (the `member` row + `member.role`) to
// the PDP's authorization model (the `grants` table). The PDP authorizes from grants,
// NOT from member.role — so every org-membership change must sync a matching org-wide
// grant, or an invited member would have a row but no access. The ee/ organization
// plugin's member-lifecycle hooks call these via CoreContext (so ee/ never imports
// core internals). Membership roles == the PDP roles (owner/admin/operator/viewer),
// see lib/authz/org-access-control.ts.

import { and, eq, sql } from "drizzle-orm";
import { toPdpRole } from "@/lib/authz/org-access-control";
import { BUILTIN_ROLE_IDS } from "@/lib/authz/registry";
import { getTupleSync } from "@/lib/authz/tuple-sync";
import { getServiceDb } from "@/lib/db";
import { member, user } from "@/lib/db/schema";

/** Mirror a grant change to OpenFGA, best-effort (Postgres is the source of truth). */
function mirror(run: Promise<void>): void {
	void run.catch((err) => console.error("[authz] tuple sync failed:", err));
}

/**
 * Sets a member's org-wide PDP grant to `role` (so the PDP authorizes them within
 * the org). Idempotent SET semantics — replaces any existing org-scope grant for the
 * user — so it's safe whether it fires on add, role-change, or a double event.
 *
 * A role outside the recognised set writes NO grant — and SAYS SO. It used to return in
 * silence, and that silence is the whole of #3730: Better Auth's built-in `member` role (the
 * `member.role` column default, the SSO plugin's JIT default, and what an invitation carries)
 * was unrecognised, so every accepted invitation produced a member row with zero permissions
 * and an org overview that threw ForbiddenError into its error boundary. `toPdpRole` now maps
 * it; a member left ungranted is a defect either way, so it is logged loudly rather than
 * dropped — a member with no grant is invisible in the product until someone loads a page.
 *
 * A member whose `member.status` is anything but `active` gets NO grant either (#5465). The
 * member LIFECYCLE writers come through here — the ee lifecycle hooks (create, add, accept, role
 * change), reactivation in `setMemberSuspended`, onboarding, the paid org setup and the #3754
 * operator command — so the rule holds for all of them. The explicit grant APIs (`assignGrant`,
 * `POST /api/cli/grants`) do not write through here; they refuse through `isNonActiveMember`
 * (#5472). Before this check, promoting a SUSPENDED member re-wrote their
 * grant and the PDP let them back in while the members table still said suspended.
 *
 * The status is read `for update` inside the same transaction as the write, so a suspension that
 * commits while this runs either lands first (and is seen here) or waits for this write and then
 * revokes it.
 *
 * A user with NO member row is granted only in their PERSONAL scope, which is the org whose id is
 * their own user id (`lib/auth/index.ts` grants it at sign-up; it has no member row by design). In
 * any other org a missing row means the member was removed, and is refused (#5472): a role change
 * whose `afterUpdateMemberRole` ran after a concurrent removal deleted the row used to grant the
 * removed user again here, after `afterRemoveMember` had revoked them.
 */
export async function ensureMemberGrant(
	orgId: string,
	userId: string,
	role: string,
): Promise<void> {
	const resolved = toPdpRole(role);
	if (!resolved) {
		console.error(
			`[authz] member ${userId} in org ${orgId} has role "${role}", which maps to no PDP ` +
				`role — NO grant written, so they will be denied everything in this org. ` +
				`Add it to MEMBERSHIP_ROLE_ALIASES in lib/authz/org-access-control.ts if it is real.`,
		);
		return;
	}
	const roleId = BUILTIN_ROLE_IDS[resolved];
	const refusedStatus = await getServiceDb().transaction(async (tx) => {
		const [m] = await tx
			.select({ status: member.status })
			.from(member)
			.where(and(eq(member.organizationId, orgId), eq(member.userId, userId)))
			.for("update");
		if (!m && orgId !== userId) return "not a member";
		if (m && m.status !== "active") return m.status;
		await tx.execute(sql`
			delete from grants
			where org_id = ${orgId}::uuid and principal_type = 'user'
			  and principal_id = ${userId}::uuid
			  and resource_type = 'org' and resource_id is null
		`);
		await tx.execute(sql`
			insert into grants (org_id, principal_type, principal_id, role_id, resource_type)
			values (${orgId}::uuid, 'user', ${userId}::uuid, ${roleId}::uuid, 'org')
		`);
		return null;
	});
	if (refusedStatus !== null) {
		console.warn(
			`[authz] user ${userId} in org ${orgId} is "${refusedStatus}", not an active member — NO ` +
				`grant written. Reactivating a suspended member (setMemberSuspended) grants their role.`,
		);
		return;
	}
	mirror(getTupleSync().syncMemberGrant(orgId, userId, resolved));
}

/** The sentence the grant APIs refuse an allow grant to a member who is not active with. */
export const INACTIVE_PRINCIPAL_MESSAGE =
	"That member is not active. Reactivate them before granting access.";

/**
 * Whether user `userId` holds a member row in org `orgId` whose status is not `active` (#5472). No
 * member row answers false: the personal scope (org id = user id) has none by design.
 *
 * The explicit grant APIs (`assignGrant`, `POST /api/cli/grants`) take a principal id from the
 * request and refuse an ALLOW grant to such a member, the rule `ensureMemberGrant` applies to the
 * member lifecycle; a deny grant only removes access, so it is not refused. That is a read before
 * their insert, not a lock: a suspension that commits between the two leaves an allow row behind,
 * which neither PDP honours (see `lacksActiveMembership`). The ee `beforeCreateInvitation` hook
 * refuses such an inviter.
 */
export async function isNonActiveMember(orgId: string, userId: string): Promise<boolean> {
	const [m] = await getServiceDb()
		.select({ status: member.status })
		.from(member)
		.where(and(eq(member.organizationId, orgId), eq(member.userId, userId)))
		.limit(1);
	return m !== undefined && m.status !== "active";
}

/**
 * Whether user `userId` may hold NO access in org `orgId` because they are not an active member of
 * it: true when their member row there is not `active`, and also when they have no member row at
 * all. The one exception is the personal scope (org id = user id), which has no member row by design
 * and answers false.
 *
 * Both PDPs deny such an actor everything in the org (#5472). `PostgresRbacPDP.matchingGrants`
 * applies it in its own query; the ee OpenFGA PDP calls this before it reads a tuple. The reason is
 * the same for both: a suspended or removed member's TEAM membership (`team_member` rows, and the
 * `team:T#member@user:U` tuples mirrored from them) is not removed by suspension or by every removal
 * path, and a team's grants are resolved through it. A user grant left behind with no member row is
 * honoured by neither engine for the same reason: no writer of a grant row in a non-personal org
 * writes one for a user who is not an active member there (`ensureMemberGrant`, `assignGrant` and
 * `POST /api/cli/grants` refuse), so such a row is a leftover, not access.
 */
export async function lacksActiveMembership(orgId: string, userId: string): Promise<boolean> {
	if (orgId === userId) return false;
	const [m] = await getServiceDb()
		.select({ status: member.status })
		.from(member)
		.where(and(eq(member.organizationId, orgId), eq(member.userId, userId)))
		.limit(1);
	return m === undefined || m.status !== "active";
}

/** The sentence an invitation is refused with when its inviter may no longer invite. */
export const INVITER_NOT_ACTIVE_MESSAGE =
	"The person who sent this invitation is no longer an active member of the team, so it can't be accepted. Ask a current admin to invite you again.";

/**
 * Why invitation into org `orgId` sent by user `inviterId` may not be accepted, or null when it may
 * (#5472). An invitation is accepted later than it is sent, and better-auth's accept does not
 * re-check the inviter: an admin who invited a second account they control and was THEN suspended or
 * removed would still get that account in, at the role they chose. So an invitation is honoured
 * only while its inviter is an active member of the org.
 *
 * The platform system user (`PLATFORM_SYSTEM_USER_EMAIL`) is the exception: it is the inviter on
 * the owner invitations `provisionOrg` issues and is never a member of any org by design.
 */
export async function inviterRefusal(
	orgId: string,
	inviterId: string,
): Promise<string | null> {
	if (!(await lacksActiveMembership(orgId, inviterId))) return null;
	const platformEmail = process.env.PLATFORM_SYSTEM_USER_EMAIL?.trim().toLowerCase();
	if (platformEmail) {
		const [row] = await getServiceDb()
			.select({ email: user.email })
			.from(user)
			.where(eq(user.id, inviterId))
			.limit(1);
		if (row && row.email.trim().toLowerCase() === platformEmail) return null;
	}
	return INVITER_NOT_ACTIVE_MESSAGE;
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
