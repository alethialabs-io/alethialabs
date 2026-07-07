// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { getEnterprise } from "@/lib/enterprise";
import { COMMUNITY_ENTITLEMENTS } from "@/lib/billing/plan";
import type { Actor } from "@/lib/authz/types";

/**
 * Resolves a verified user's active tenancy scope — the seam between identity and
 * authorization (project 07 Part F, seam 2). Community is single-tenant: the user's
 * personal org is their own id, so `orgId === userId` (the optional `activeOrgId` is
 * ignored — there is only the personal org). The `ee/` Teams build registers a
 * resolver that maps the user to their selected organization (validating membership)
 * — without touching any call site.
 *
 * Entitlements for the resolved org are resolved here too (once per request, async),
 * so call sites read them synchronously via getEntitlements(). The ee/ resolver
 * decides per-org from the billing record / signed license; community is all-off.
 */
export async function getActiveScope(
	userId: string,
	activeOrgId?: string,
): Promise<Actor> {
	const enterprise = getEnterprise();
	const base: Actor = enterprise?.resolveScope
		? await enterprise.resolveScope(userId, activeOrgId)
		: { userId, orgId: userId };
	const entitlements = enterprise?.resolveEntitlements
		? await enterprise.resolveEntitlements(base.orgId)
		: COMMUNITY_ENTITLEMENTS;
	return { ...base, entitlements };
}
