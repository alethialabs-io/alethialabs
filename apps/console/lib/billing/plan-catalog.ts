// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The single display source of truth for plans — name, price, tagline, the short
// highlights for compact cards, and the grouped "What's included" breakdown for the
// rich plan chooser. Co-located with the entitlement ladder (lib/billing/plan.ts) so
// the copy and the enforced entitlements never drift. Prices are display labels only —
// the authoritative amounts live in Stripe (STRIPE_PRICE_*).

import type { BillingPlan } from "@/lib/db/schema/enums";

/** A titled group of features for the "What's included" slice. */
export interface PlanFeatureGroup {
	label: string;
	items: string[];
}

export interface PlanCatalogEntry {
	id: BillingPlan;
	name: string;
	/** Display price (the authoritative amount is the Stripe price). */
	priceLabel: string;
	tagline: string;
	/** Paid tier (has a Stripe price) vs the free community baseline. */
	paid: boolean;
	/** Highlight as the recommended tier. */
	popular?: boolean;
	/** The tier this one builds on — drives the "Everything in {name}, plus:" rollup. */
	inheritsFrom?: BillingPlan;
	/** Short punchy list for compact cards (PlanPicker). */
	highlights: string[];
	/** Grouped feature breakdown for the rich chooser ("What's included"). */
	included: PlanFeatureGroup[];
}

export const PLAN_CATALOG: PlanCatalogEntry[] = [
	{
		id: "community",
		name: "Free",
		priceLabel: "Free",
		tagline: "Your own Zones & Specs — just you.",
		paid: false,
		highlights: [
			"Unlimited personal Zones & Specs",
			"Multi-cloud provisioning",
			"Community RBAC",
		],
		included: [
			{
				label: "Platform",
				items: [
					"Unlimited personal Zones & Specs",
					"Multi-cloud provisioning (AWS / GCP / Azure)",
					"Pluggable integrations catalog",
					"GitOps app delivery",
				],
			},
			{
				label: "Access",
				items: ["Built-in roles", "Single-tenant — just you"],
			},
		],
	},
	{
		id: "team",
		name: "Team",
		priceLabel: "$29 / seat / mo",
		tagline: "Collaborate in a shared organization.",
		paid: true,
		popular: true,
		inheritsFrom: "community",
		highlights: [
			"Organizations & teams",
			"Invite teammates",
			"Shared Zones & Specs",
			"Role-based access",
		],
		included: [
			{
				label: "Collaboration",
				items: [
					"Organizations & teams",
					"Invite unlimited teammates",
					"Shared Zones & Specs",
					"Per-team resource grants",
				],
			},
			{
				label: "Access",
				items: [
					"Built-in roles (owner / admin / operator / viewer)",
					"Member management",
				],
			},
		],
	},
	{
		id: "business",
		name: "Business",
		priceLabel: "$999 / mo",
		tagline: "Governance for a growing team.",
		paid: true,
		inheritsFrom: "team",
		highlights: [
			"Everything in Team",
			"Custom roles (granular RBAC)",
			"Audit log export",
			"Priority support",
		],
		included: [
			{
				label: "Governance",
				items: ["Custom roles (granular RBAC)", "Fine-grained access policies"],
			},
			{
				label: "Compliance",
				items: ["Audit log + export", "Activity history"],
			},
			{ label: "Support", items: ["Priority support"] },
		],
	},
	{
		id: "enterprise",
		name: "Enterprise",
		priceLabel: "$2,500 / mo",
		tagline: "Security & scale for the whole org.",
		paid: true,
		inheritsFrom: "business",
		highlights: [
			"Everything in Business",
			"SSO / SAML",
			"SLA + dedicated support",
			"Self-managed license",
		],
		included: [
			{
				label: "Identity",
				items: [
					"SSO / SAML",
					"IdP group → role mapping",
					"SCIM provisioning (coming soon)",
				],
			},
			{
				label: "Security & compliance",
				items: ["Zero-key attestation", "Compliance package (SOC2-aligned)"],
			},
			{
				label: "Support",
				items: ["SLA + dedicated support", "Self-managed license option"],
			},
		],
	},
];

/** The paid tiers, in upgrade order (the create-org chooser + upgrade UI). */
export const PAID_PLANS = PLAN_CATALOG.filter((p) => p.paid);

/** Catalog metadata for a plan (falls back to community). */
export function planMeta(plan: BillingPlan): PlanCatalogEntry {
	return PLAN_CATALOG.find((p) => p.id === plan) ?? PLAN_CATALOG[0];
}
