// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The two questions the console's team endpoints ask before a team write, asked the same way for
// the CLI team routes:
//
//   1. May the caller's membership role do this to teams? Read from `orgRoles` through
//      `membershipMayManageTeams` — the table the organization plugin's `hasPermission` reads —
//      so owners and admins may, and operators and viewers may not.
//   2. (Create only.) Does the organization hold the `teams` entitlement? Read through
//      `canOrgCreateTeams` with the enterprise module's entitlement resolver — the instance
//      licence when one grants, the organization's billing record otherwise — which is the
//      resolver the plugin's `beforeCreateTeam` hook passes. A build without the enterprise module
//      answers from the community baseline, which carries no teams.
//
// The PDP check each route already makes (`member:manage_members`) stays in front of these; this
// module adds the console's rule, it does not replace the route's.

import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { membershipMayManageTeams, type TeamAction } from "@/lib/authz/org-access-control";
import type { Entitlements } from "@/lib/authz/types";
import { canOrgCreateTeams } from "@/lib/billing/collaboration";
import { COMMUNITY_ENTITLEMENTS } from "@/lib/billing/plan";
import { getServiceDb } from "@/lib/db";
import { member } from "@/lib/db/schema";
import { getEnterprise } from "@/lib/enterprise";

/** The refusal text for a caller whose role may not perform `action` on teams. */
const ROLE_REFUSAL: { readonly [A in TeamAction]: string } = {
	create: "Only an organization owner or admin can create teams.",
	update: "Only an organization owner or admin can rename teams.",
	delete: "Only an organization owner or admin can delete teams.",
};

/** The refusal text for an organization without the teams entitlement (the console's wording). */
const TEAMS_PLAN_REFUSAL = "Teams require an Enterprise plan.";

/**
 * The stored role of `userId`'s ACTIVE membership in `orgId`, or null when there is none. A
 * suspended row holds no role here, as it holds no grant. A service token's `userId` is the profile
 * that minted it, so the token acts with that member's role.
 */
async function activeMembershipRole(userId: string, orgId: string): Promise<string | null> {
	const [row] = await getServiceDb()
		.select({ role: member.role })
		.from(member)
		.where(
			and(eq(member.userId, userId), eq(member.organizationId, orgId), eq(member.status, "active")),
		)
		.limit(1);
	return row?.role ?? null;
}

/**
 * A 403 when `userId` may not perform `action` on teams in `orgId` (no active membership, or a role
 * that does not hold it), else null.
 */
export async function teamRoleRefusal(
	userId: string,
	orgId: string,
	action: TeamAction,
): Promise<Response | null> {
	const role = await activeMembershipRole(userId, orgId);
	if (role !== null && membershipMayManageTeams(role, action)) return null;
	return NextResponse.json({ error: ROLE_REFUSAL[action] }, { status: 403 });
}

/** The entitlement resolver the team gate reads: the enterprise module's, else the community baseline. */
function teamEntitlementResolver(): (orgId: string) => Promise<Entitlements> {
	const resolve = getEnterprise()?.resolveEntitlements;
	return resolve ?? (async () => COMMUNITY_ENTITLEMENTS);
}

/** A 403 when organization `orgId` does not hold the teams entitlement, else null. */
export async function teamPlanRefusal(orgId: string): Promise<Response | null> {
	if (await canOrgCreateTeams(orgId, teamEntitlementResolver())) return null;
	return NextResponse.json({ error: TEAMS_PLAN_REFUSAL }, { status: 403 });
}
