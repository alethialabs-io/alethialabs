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
			};
		default:
			return COMMUNITY_ENTITLEMENTS;
	}
}

/** A subscription only grants its plan's paid entitlements while live. */
export function isBillingActive(status: BillingStatus): boolean {
	return status === "active" || status === "trialing";
}

/** The billing-row columns naming the ORG-PLAN subscription, one per payment provider. */
export interface PlanSubscriptionIds {
	stripeSubscriptionId: string | null;
	paddleSubscriptionId: string | null;
}

/** The billing-row columns naming the standalone AI subscription, one per payment provider. */
export interface AiSubscriptionIds {
	aiStripeSubscriptionId: string | null;
	aiPaddleSubscriptionId: string | null;
}

/**
 * Whether the org-plan slot is backed by a provider subscription (Stripe or Paddle) — a provider's
 * webhook maintains its status and renewal date, so nothing local may lapse it.
 */
export function hasPlanSubscription(row: PlanSubscriptionIds): boolean {
	return row.stripeSubscriptionId != null || row.paddleSubscriptionId != null;
}

/** Whether the standalone AI slot is backed by a provider subscription (Stripe or Paddle). */
export function hasAiSubscription(row: AiSubscriptionIds): boolean {
	return row.aiStripeSubscriptionId != null || row.aiPaddleSubscriptionId != null;
}

/**
 * Whether the row holds ANY provider subscription — any of the four subscription id columns (plan or
 * AI, Stripe or Paddle). A grant decision about ONE slot must ask that slot's helper instead
 * (`hasPlanSubscription` / `hasAiSubscription`): an AI subscription does not maintain the plan's
 * `currentPeriodEnd`, so reading it as "the plan is provider-backed" would let an off-provider plan
 * grant on the same row run forever.
 */
export function hasProviderSubscription(row: PlanSubscriptionIds & AiSubscriptionIds): boolean {
	return hasPlanSubscription(row) || hasAiSubscription(row);
}

/**
 * True when a manual / off-provider grant has lapsed — the off-provider analogue of a
 * non-renewed subscription. Enterprise is invoiced off-Stripe and marked paid directly
 * (scripts/set-org-plan.mjs / the platform operator plane), writing `currentPeriodEnd`
 * to the contract's term end. Nothing else reads that column, so without this check such
 * a grant would stay paid forever. Scoped to grants with NO plan subscription at any provider
 * (`hasPlanSubscription`: Stripe or Paddle) so a real paying customer — whose renewal date the
 * provider's webhook maintains — is never affected (a late renewal webhook must never flicker a
 * paying customer down to community mid-cycle). An open-ended grant (`currentPeriodEnd` null)
 * never lapses.
 */
export function isManualGrantExpired(
	billing: PlanSubscriptionIds & { currentPeriodEnd: Date | null },
	now: Date = new Date(),
): boolean {
	return (
		!hasPlanSubscription(billing) &&
		billing.currentPeriodEnd != null &&
		billing.currentPeriodEnd.getTime() < now.getTime()
	);
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
