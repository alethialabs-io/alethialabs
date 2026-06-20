// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The single display source of truth for plans — name, price label, tagline, and the
// human-readable features each tier unlocks. Co-located with the entitlement ladder
// (lib/billing/plan.ts) so the UI copy and the enforced entitlements never drift. Used
// by the PlanPicker, the billing panel, and the create-organization sheet. Prices are
// display labels only — the real amounts live in Stripe (STRIPE_PRICE_*).

import type { BillingPlan } from "@/lib/db/schema/enums";

export interface PlanCatalogEntry {
	id: BillingPlan;
	name: string;
	/** Display price (the authoritative amount is the Stripe price). */
	priceLabel: string;
	tagline: string;
	/** What this tier unlocks, additive over the one below it. */
	features: string[];
	/** Paid tier (has a Stripe price) vs the free community baseline. */
	paid: boolean;
}

export const PLAN_CATALOG: PlanCatalogEntry[] = [
	{
		id: "community",
		name: "Free",
		priceLabel: "Free",
		tagline: "Your own Zones & Specs — just you.",
		features: [
			"Unlimited personal Zones & Specs",
			"Full provisioning + integrations",
			"Community RBAC",
		],
		paid: false,
	},
	{
		id: "team",
		name: "Team",
		priceLabel: "$29 / seat / mo",
		tagline: "Collaborate in a shared organization.",
		features: [
			"Organizations & teams",
			"Invite teammates",
			"Shared Zones & Specs",
			"Role-based access",
		],
		paid: true,
	},
	{
		id: "business",
		name: "Business",
		priceLabel: "$999 / mo",
		tagline: "Governance for a growing team.",
		features: [
			"Everything in Team",
			"Custom roles (granular RBAC)",
			"Audit log export",
			"Priority support",
		],
		paid: true,
	},
	{
		id: "enterprise",
		name: "Enterprise",
		priceLabel: "$2,500 / mo",
		tagline: "Security & scale for the whole org.",
		features: [
			"Everything in Business",
			"SSO / SAML",
			"SLA + dedicated support",
			"Self-managed license option",
		],
		paid: true,
	},
];

/** The paid tiers, in upgrade order (the create-org sheet + upgrade UI). */
export const PAID_PLANS = PLAN_CATALOG.filter((p) => p.paid);

/** Catalog metadata for a plan (falls back to community). */
export function planMeta(plan: BillingPlan): PlanCatalogEntry {
	return PLAN_CATALOG.find((p) => p.id === plan) ?? PLAN_CATALOG[0];
}
