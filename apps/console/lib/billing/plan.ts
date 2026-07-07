// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The plan → entitlements ladder: the single source of truth for "what paying
// unlocks" (project 14-gtm-pricing). It is a PURE function with no I/O and no ee/
// import, so it is safe to live in core and be called from both the community
// fallback and the ee/ per-org resolution. The COMMERCIAL decision — which plan an
// org is actually on, and whether its subscription is active — lives in ee/
// (it reads the billing record / signed license); this only maps a known plan to flags.

import type { BillingPlan, BillingStatus } from "@/lib/db/schema/enums";
import type { Entitlements } from "@/lib/authz/types";

/** Community baseline — every enterprise feature off. The implicit plan. */
export const COMMUNITY_ENTITLEMENTS: Entitlements = {
	organizations: false,
	teams: false,
	sso: false,
	customRoles: false,
	activityExport: false,
	alerting: false,
	advancedAlerting: false,
	byoRunners: false,
	managedPools: false,
	quotas: {
		maxConcurrentJobs: 2,
		priorityLevel: 0,
		includedRunnerMinutes: 200,
		activityRetentionDays: 7,
	},
	// Free trial: a taste of AI (illustrative credits; scan ~20, message ~1 — tune later).
	ai: { enabled: true, tier: "trial", windowCredits: 30, windowHours: 5, weeklyCredits: 100 },
};

/**
 * The granular ladder (each tier is additive over the one below it):
 *  - community  → all off (single-tenant: own projects only)
 *  - team       → organizations (invite + collaborate) + alerting (policies/channels)
 *  - enterprise → + teams + custom roles + activity export + advanced (PDP) alerting + SSO/SAML
 *
 * Adjusting what a tier grants is a one-line edit here.
 */
export function planEntitlements(plan: BillingPlan): Entitlements {
	switch (plan) {
		case "team":
			return {
				...COMMUNITY_ENTITLEMENTS,
				organizations: true,
				alerting: true,
				byoRunners: true,
				quotas: {
					maxConcurrentJobs: 8,
					priorityLevel: 10,
					includedRunnerMinutes: 500,
					activityRetentionDays: 30,
				},
				// AI "Standard" (×1).
				ai: { enabled: true, tier: "standard", windowCredits: 300, windowHours: 5, weeklyCredits: 3_000 },
			};
		case "enterprise":
			return {
				organizations: true,
				teams: true,
				customRoles: true,
				activityExport: true,
				alerting: true,
				advancedAlerting: true,
				sso: true,
				byoRunners: true,
				managedPools: true,
				quotas: {
					maxConcurrentJobs: null,
					priorityLevel: 30,
					includedRunnerMinutes: 20_000,
					activityRetentionDays: 365,
				},
				// AI "20×".
				ai: {
					enabled: true,
					tier: "max",
					windowCredits: 6_000,
					windowHours: 5,
					weeklyCredits: 60_000,
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
