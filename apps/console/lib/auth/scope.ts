// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { editionState, getEnterprise } from "@/lib/enterprise";
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

/**
 * How the personal-scope collapse in `currentActor()` must be read (#6149, ADR 0005 Q5):
 *
 * - `single-tenant` — the edition is community BY CONFIGURATION (`ALETHIA_EDITION=community`):
 *   every org slug legitimately resolves to the personal scope.
 * - `unconfigured` — the edition is unset and `@alethia/ee` was not found. That is what a real AGPL
 *   checkout looks like AND what a resolution failure looks like (F049); the two cannot be told
 *   apart, so it is refused and named instead of served.
 * - `multi-tenant` — an enterprise resolver is registered; a collapse to personal for an org
 *   address is a substitution.
 *
 * A failed enterprise load throws from here, as it does from `getEnterprise()`.
 */
export function tenancyMode(): "single-tenant" | "unconfigured" | "multi-tenant" {
	const edition = editionState();
	if (edition.kind === "failed") throw edition.error;
	if (edition.kind === "enterprise") return "multi-tenant";
	return edition.reason === "configured" ? "single-tenant" : "unconfigured";
}
