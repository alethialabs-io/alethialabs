// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The "an organization keeps an active owner" rules for a ROLE CHANGE (#5465), and for a REMOVAL
// or a LEAVE (#5472).
//
// better-auth's `/organization/update-member-role` refuses only one shape of it: an owner demoting
// THEMSELVES while they are the last member whose role contains `owner`. It counts suspended owners
// as owners, and it reads the role with a plain `split(",")`. So an org whose second owner was
// suspended let its one active owner demote themselves, leaving no one able to manage it. This rule
// reads roles the way the PDP does (`toPdpRole`) and counts only ACTIVE members. The ee organization
// plugin runs `roleChangeOwnerRefusal` in `beforeUpdateMemberRole` and `removalOwnerRefusal` in
// `beforeRemoveMember`, injected through `CoreContext`; better-auth's `/organization/leave` fires no
// hook, so `app/api/auth/[...all]/route.ts` runs `removalOwnerRefusal` before it.
//
// Each is a read-then-write across two statements (this check, then better-auth's write), so two
// owners demoting or removing each other at the same instant can both pass it. It is not a lock.

import { eq } from "drizzle-orm";
import { toPdpRole } from "@/lib/authz/org-access-control";
import { getServiceDb } from "@/lib/db";
import { member } from "@/lib/db/schema";

/** The sentence a refused role change, removal or leave answers with. */
export const LAST_ACTIVE_OWNER_MESSAGE =
	"This is the team's only active owner. Make another active member an owner first.";

/** The sentence a refused promotion of a member who is not active answers with (#5472). */
export const INACTIVE_OWNER_MESSAGE =
	"A suspended member can't be made an owner. Reactivate them first.";

/** The org's member rows, as the rules below read them. */
async function orgMembers(
	orgId: string,
): Promise<{ id: string; role: string; status: string }[]> {
	return getServiceDb()
		.select({ id: member.id, role: member.role, status: member.status })
		.from(member)
		.where(eq(member.organizationId, orgId));
}

/**
 * Whether member `memberId` is an ACTIVE owner (by `toPdpRole`) and no other active member of the
 * same rows is one, i.e. whether taking them away leaves the org with no active owner.
 */
function isLastActiveOwner(
	rows: { id: string; role: string; status: string }[],
	memberId: string,
): boolean {
	const activeOwners = rows.filter(
		(m) => m.status === "active" && toPdpRole(m.role) === "owner",
	);
	return activeOwners.length === 1 && activeOwners[0]?.id === memberId;
}

/**
 * Why changing member `memberId` of org `orgId` to `newRole` must be refused, or null when it may
 * go ahead.
 *
 * - A change that takes the org's last ACTIVE owner (by `toPdpRole`, so `owner,admin` is an owner)
 *   to a non-owner role leaves the org with no active owner.
 * - A change that makes a member who is NOT active an owner (#5472). `setMemberSuspended` refuses
 *   to suspend an owner, so that no owner is ever suspended; promoting a suspended member would
 *   create one, and better-auth's leave and remove checks count that suspended owner as an owner.
 */
export async function roleChangeOwnerRefusal(
	orgId: string,
	memberId: string,
	newRole: string,
): Promise<string | null> {
	const rows = await orgMembers(orgId);
	if (toPdpRole(newRole) === "owner") {
		const target = rows.find((m) => m.id === memberId);
		return target && target.status !== "active" ? INACTIVE_OWNER_MESSAGE : null;
	}
	return isLastActiveOwner(rows, memberId) ? LAST_ACTIVE_OWNER_MESSAGE : null;
}

/**
 * Why removing member `memberId` from org `orgId` (better-auth's remove-member, or the member
 * leaving) must be refused, or null when it may go ahead (#5472). It is refused when the member is
 * the org's last ACTIVE owner. better-auth's own check counts suspended owners as owners, so it let
 * the one active owner go while a suspended one remained.
 *
 * Like `roleChangeOwnerRefusal` it is a read before the caller's delete, not a lock.
 */
export async function removalOwnerRefusal(
	orgId: string,
	memberId: string,
): Promise<string | null> {
	return isLastActiveOwner(await orgMembers(orgId), memberId)
		? LAST_ACTIVE_OWNER_MESSAGE
		: null;
}
