// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The plan → entitlements ladder: the single source of truth for "what paying
// unlocks" (spec 14-gtm-pricing). It is a PURE function with no I/O and no ee/
// import, so it is safe to live in core and be called from both the community
// fallback and the ee/ per-org resolution. The COMMERCIAL decision — which plan an
// org is actually on, and whether its subscription is active — lives in ee/
// (it reads the billing record / signed license); this only maps a known plan to flags.

import type { BillingPlan, BillingStatus } from "@/lib/db/schema/enums";
import type { Entitlements } from "@/lib/authz/types";

/** Community baseline — every enterprise feature off. The implicit plan. */
export const COMMUNITY_ENTITLEMENTS: Entitlements = {
	organizations: false,
	sso: false,
	customRoles: false,
	auditExport: false,
	advancedAlerting: false,
	quotas: { maxConcurrentJobs: 2, priorityLevel: 0, includedRunnerMinutes: 200 },
};

/**
 * The granular ladder (each tier is additive over the one below it):
 *  - community  → all off (single-tenant: own zones/specs only, no teams)
 *  - team       → organizations/teams
 *  - business   → + custom roles + audit export
 *  - enterprise → + SSO/SAML
 *
 * Adjusting what a tier grants is a one-line edit here.
 */
export function planEntitlements(plan: BillingPlan): Entitlements {
	switch (plan) {
		case "team":
			return {
				...COMMUNITY_ENTITLEMENTS,
				organizations: true,
				quotas: {
					maxConcurrentJobs: 8,
					priorityLevel: 10,
					includedRunnerMinutes: 500,
				},
			};
		case "business":
			return {
				...COMMUNITY_ENTITLEMENTS,
				organizations: true,
				customRoles: true,
				auditExport: true,
				advancedAlerting: true,
				quotas: {
					maxConcurrentJobs: 20,
					priorityLevel: 20,
					includedRunnerMinutes: 5_000,
				},
			};
		case "enterprise":
			return {
				organizations: true,
				customRoles: true,
				auditExport: true,
				advancedAlerting: true,
				sso: true,
				quotas: {
					maxConcurrentJobs: null,
					priorityLevel: 30,
					includedRunnerMinutes: 20_000,
				},
			};
		default:
			return COMMUNITY_ENTITLEMENTS;
	}
}

/** A subscription only grants its plan's paid entitlements while live. */
export function isBillingActive(status: BillingStatus): boolean {
	return status === "active" || status === "trialing";
}

/**
 * Resolves a billing record (plan + status) to entitlements: the plan's grant when
 * the subscription is live, the community baseline otherwise. The one place that
 * ties "active subscription" to "unlocked features".
 */
export function resolvePlanEntitlements(
	plan: BillingPlan,
	status: BillingStatus,
): Entitlements {
	return isBillingActive(status)
		? planEntitlements(plan)
		: COMMUNITY_ENTITLEMENTS;
}
