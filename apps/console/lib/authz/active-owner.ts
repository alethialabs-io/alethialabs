// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The "an organization keeps an active owner" rule for a ROLE CHANGE (#5465).
//
// better-auth's `/organization/update-member-role` refuses only one shape of it: an owner demoting
// THEMSELVES while they are the last member whose role contains `owner`. It counts suspended owners
// as owners, and it reads the role with a plain `split(",")`. So an org whose second owner was
// suspended let its one active owner demote themselves, leaving no one able to manage it. This rule
// reads roles the way the PDP does (`toPdpRole`) and counts only ACTIVE members. The ee organization
// plugin runs it in `beforeUpdateMemberRole`, injected through `CoreContext`.
//
// It is a read-then-write across two statements (this check, then better-auth's update), so two
// owners demoting each other at the same instant can both pass it. It is not a lock.

import { and, eq } from "drizzle-orm";
import { toPdpRole } from "@/lib/authz/org-access-control";
import { getServiceDb } from "@/lib/db";
import { member } from "@/lib/db/schema";

/** The sentence a refused role change answers with. */
export const LAST_ACTIVE_OWNER_MESSAGE =
	"This is the team's only active owner. Make another active member an owner first.";

/**
 * Why changing member `memberId` of org `orgId` to `newRole` would leave the org with no active
 * owner, or null when it would not.
 *
 * Only a change that takes an ACTIVE owner (by `toPdpRole`, so `owner,admin` is an owner) to a
 * non-owner role can do that; it is refused when no other active member of the org is an owner.
 */
export async function roleChangeOwnerRefusal(
	orgId: string,
	memberId: string,
	newRole: string,
): Promise<string | null> {
	if (toPdpRole(newRole) === "owner") return null;
	const active = await getServiceDb()
		.select({ id: member.id, role: member.role })
		.from(member)
		.where(and(eq(member.organizationId, orgId), eq(member.status, "active")));
	const target = active.find((m) => m.id === memberId);
	if (!target || toPdpRole(target.role) !== "owner") return null;
	const otherOwners = active.filter(
		(m) => m.id !== memberId && toPdpRole(m.role) === "owner",
	);
	return otherOwners.length === 0 ? LAST_ACTIVE_OWNER_MESSAGE : null;
}
