// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Typed reads/writes for the per-org billing record. The billing table is a
// tenancy-control concern (it decides entitlements), so it is queried via the
// service connection (bypasses RLS) and the org boundary is enforced by the caller
// passing the resolved actor.orgId — never user input.

import { eq } from "drizzle-orm";
import { getServiceDb } from "@/lib/db";
import {
	organizationBilling,
	type OrganizationBilling,
} from "@/lib/db/schema";
import type { Entitlements } from "@/lib/authz/types";
import { COMMUNITY_ENTITLEMENTS, resolvePlanEntitlements } from "./plan";

/** Returns an org's billing record, or null if it has none (→ implicitly community). */
export async function getOrgBilling(
	orgId: string,
): Promise<OrganizationBilling | null> {
	const [row] = await getServiceDb()
		.select()
		.from(organizationBilling)
		.where(eq(organizationBilling.organizationId, orgId))
		.limit(1);
	return row ?? null;
}

/**
 * Resolves an org's entitlements from its billing record: the plan's grant when the
 * subscription is live, the community baseline if there's no row or it's inactive.
 * This is the per-org resolution the ee/ entitlements seam delegates to (replacing
 * the global ALETHIA_LICENSE_ACTIVE env flag).
 */
export async function resolveOrgEntitlements(
	orgId: string,
): Promise<Entitlements> {
	const billing = await getOrgBilling(orgId);
	if (!billing) return COMMUNITY_ENTITLEMENTS;
	return resolvePlanEntitlements(billing.plan, billing.status);
}
