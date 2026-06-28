// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The single source of truth for plans — name, price (label + numeric unit), tagline,
// the short highlights for compact cards, and the grouped "What's included" breakdown
// for the rich plan chooser. Shared by the console billing UI and the marketing pricing
// page so the copy never drifts. `priceLabel` + `priceMonthlyUsd` drive display and
// in-app math (e.g. seats × unit); the authoritative CHARGE amount still lives in Stripe
// (STRIPE_PRICE_*). Keep the label and the number in step (they sit in the same entry).
//
// `PlanId` is declared here (not imported from the console DB enum) so the package has no
// app dependencies. It is kept structurally identical to the `billing_plan` pgEnum
// (lib/db/schema/enums.ts) — the console's `BillingPlan` type is assignable to it.

/** The billing plan tiers, matching the `billing_plan` pgEnum in the console schema. */
export type PlanId = "community" | "team" | "enterprise";

/** A titled group of features for the "What's included" slice. */
export interface PlanFeatureGroup {
	label: string;
	items: string[];
}

/** A checkout "What's included" line — a bold title + a sub-label detail. */
export interface CheckoutFeature {
	title: string;
	detail: string;
}

export interface PlanCatalogEntry {
	id: PlanId;
	name: string;
	/** Display price (the authoritative amount is the Stripe price). */
	priceLabel: string;
	/** Per-period USD unit for in-app math — per **seat** when `perSeat`, flat otherwise.
	 *  `undefined` = custom / "Let's talk" (Enterprise). Keep in step with `priceLabel`. */
	priceMonthlyUsd?: number;
	/** Whether `priceMonthlyUsd` is multiplied by the seat count (per-seat billing). */
	perSeat?: boolean;
	/** Monthly usage credit (USD) included with the plan — offsets metered charges. */
	includedCreditUsd?: number;
	tagline: string;
	/** Paid tier (has a Stripe price) vs the free community baseline. */
	paid: boolean;
	/** Highlight as the recommended tier. */
	popular?: boolean;
	/** The tier this one builds on — drives the "Everything in {name}, plus:" rollup. */
	inheritsFrom?: PlanId;
	/** Short punchy list for compact cards (PlanPicker). */
	highlights: string[];
	/** Grouped feature breakdown for the rich chooser ("What's included"). */
	included: PlanFeatureGroup[];
	/** Title+detail list for the checkout "What's included" rail (purchase flow). */
	checkoutFeatures?: CheckoutFeature[];
}

export const PLAN_CATALOG: PlanCatalogEntry[] = [
	{
		id: "community",
		name: "Hobby",
		priceLabel: "Free",
		priceMonthlyUsd: 0,
		tagline: "Your own Projects — just you.",
		paid: false,
		highlights: [
			"Unlimited personal Projects",
			"Multi-cloud provisioning",
			"Community RBAC",
		],
		included: [
			{
				label: "Platform",
				items: [
					"Unlimited personal Projects",
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
		name: "Pro",
		priceLabel: "$20 / seat / mo",
		priceMonthlyUsd: 20,
		perSeat: true,
		includedCreditUsd: 20,
		tagline: "Collaborate in a shared organization.",
		paid: true,
		popular: true,
		inheritsFrom: "community",
		highlights: [
			"Organizations & teams",
			"Invite teammates",
			"Shared Projects",
			"Role-based access",
		],
		checkoutFeatures: [
			{
				title: "Flexible usage credit",
				detail: "$20/mo toward metered runner-minutes & AI",
			},
			{
				title: "Organizations & teams",
				detail: "Invite teammates with role-based access",
			},
			{
				title: "Shared Projects",
				detail: "Collaborate on infrastructure across the team",
			},
			{
				title: "Included runner-minutes",
				detail: "500 managed build-minutes / month",
			},
			{
				title: "Standard AI",
				detail: "3,000 AI credits / week for repo scans & chat",
			},
			{
				title: "Priority provisioning",
				detail: "Higher concurrency and queue priority",
			},
		],
		included: [
			{
				label: "Collaboration",
				items: [
					"Organizations & teams",
					"Invite unlimited teammates",
					"Shared Projects",
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
		id: "enterprise",
		name: "Enterprise",
		priceLabel: "Let's talk",
		tagline: "Governance, security & scale for the whole org.",
		paid: true,
		inheritsFrom: "team",
		highlights: [
			"Everything in Pro",
			"Custom roles (granular RBAC)",
			"SSO / SAML",
			"Audit log export",
			"SLA + dedicated support",
		],
		included: [
			{
				label: "Governance",
				items: ["Custom roles (granular RBAC)", "Fine-grained access policies"],
			},
			{
				label: "Identity",
				items: [
					"SSO / SAML",
					"IdP group → role mapping",
					"SCIM provisioning (coming soon)",
				],
			},
			{
				label: "Compliance",
				items: [
					"Audit log + export",
					"Activity history",
					"Compliance package (SOC2-aligned)",
				],
			},
			{
				label: "Security & compliance",
				items: ["Zero-key attestation"],
			},
			{
				label: "Support",
				items: [
					"Priority support",
					"SLA + dedicated support",
					"Self-managed license option",
				],
			},
		],
	},
];

/** The paid tiers, in upgrade order (the create-org chooser + upgrade UI). */
export const PAID_PLANS = PLAN_CATALOG.filter((p) => p.paid);

/** Catalog metadata for a plan (falls back to community — the first entry). */
export function planMeta(plan: PlanId): PlanCatalogEntry {
	const found = PLAN_CATALOG.find((p) => p.id === plan);
	if (found) return found;
	const [community] = PLAN_CATALOG;
	if (!community) throw new Error("PLAN_CATALOG is empty");
	return community;
}

// ── Live-price formatting ────────────────────────────────────────────────────────
// The authoritative price amount lives in Stripe; both the console and the marketing
// site read it live and render it with these shared helpers (so a "$29 / seat / mo"
// label is formatted identically everywhere). The catalog's priceLabel/priceMonthlyUsd
// are the FALLBACK used only when Stripe isn't configured / the lookup fails.

/** Minimal currency-symbol map; falls back to the uppercase ISO code + space. */
const CURRENCY_SYMBOL: Record<string, string> = {
	usd: "$",
	eur: "€",
	gbp: "£",
};

/** "month" → "mo", "year" → "yr"; anything else passes through (default "mo"). */
export function shortInterval(interval: string | undefined | null): string {
	if (interval === "month") return "mo";
	if (interval === "year") return "yr";
	return interval ?? "mo";
}

/** "$29" — whole amounts drop the cents, fractional amounts keep two decimals. */
export function formatMoney(unitAmountCents: number, currency: string): string {
	const symbol = CURRENCY_SYMBOL[currency] ?? `${currency.toUpperCase()} `;
	const amount = unitAmountCents / 100;
	const value = Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
	return `${symbol}${value}`;
}

/** Format a Stripe price into a per-seat label like "$29 / seat / mo". */
export function formatSeatPrice(
	unitAmountCents: number,
	currency: string,
	interval: string | undefined | null,
): string {
	return `${formatMoney(unitAmountCents, currency)} / seat / ${shortInterval(interval)}`;
}
