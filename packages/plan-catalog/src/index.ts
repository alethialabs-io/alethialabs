// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The single source of truth for plans — name, price (label + numeric unit), tagline,
// the short highlights for compact cards, and the grouped "What's included" breakdown
// for the rich plan chooser. Shared by the console billing UI and the marketing pricing
// page so the copy never drifts. `priceLabel` + `priceMonthly` drive display and
// in-app math (e.g. seats × unit); the authoritative CHARGE amount still lives in Stripe
// (STRIPE_PRICE_*). Keep the label and the number in step (they sit in the same entry).
//
// `PlanId` is declared here (not imported from the console DB enum) so the package has no
// app dependencies. It is kept structurally identical to the `billing_plan` pgEnum
// (lib/db/schema/enums.ts) — the console's `BillingPlan` type is assignable to it.

/** The billing plan tiers, matching the `billing_plan` pgEnum in the console schema. */
export type PlanId = "community" | "team" | "enterprise";

/**
 * Every currency we present + charge in. USD is the default; EU customers are billed in EUR.
 *
 * THE ARRAY IS THE ONLY LITERAL and {@link SupportedCurrency} is derived from it, for the reason
 * `packages/format/src/minor-units.ts` gives about its own list: a union and an array that are
 * typed out separately are two transcriptions of one fact, and the one nobody iterates goes stale
 * silently. Consumers that need to walk the currencies — `liveAmounts` in the console's
 * `lib/billing/pricing.ts`, and the divisor test that guards `formatPriceLabel` below — read this,
 * so widening the product to a third currency is one edit and reds everything that must be
 * revisited.
 */
export const SUPPORTED_CURRENCIES = ["usd", "eur"] as const;

/** The currencies the product sells in. Derived — see {@link SUPPORTED_CURRENCIES}. */
export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

/** Narrows an external currency code to the currencies the product currently sells. */
export function asSupportedCurrency(code: string): SupportedCurrency | null {
	return SUPPORTED_CURRENCIES.find((c) => c === code) ?? null;
}

/**
 * An amount per currency, in MINOR units — `{ usd: 2000, eur: 1800 }` is $20 / €18.
 *
 * This replaces the `priceMonthlyUsd` / `priceMonthlyEur` field PAIR that #4176 catalogued
 * (part b). Two named fields are a currency written into a TYPE, which is how a field called
 * `unitAmountUsd` ended up holding euros one layer up; a key IS the currency, so a consumer that
 * reads `amounts[currency]` cannot read the wrong one, and adding a third currency adds a key
 * rather than a field, a branch and a fallback.
 *
 * MINOR UNITS, matching `Money.minor` in `@repo/format` and Stripe's `unit_amount`. The catalog
 * held MAJOR units (20, 18) until part (b), and every consumer multiplied them back up by a
 * hardcoded 100 — `planUnitAmountCents`, `useLivePlanPrice`, the checkout form and the marketing
 * fallback label all carried their own copy of that `* 100`. They are gone; the number the
 * catalog states is the number Stripe is given.
 *
 * `Partial`, because Enterprise has no numeric price at all ("Let's talk") and a missing key is
 * how it says so. An entry that quotes USD and not EUR is legal and means exactly that.
 */
export type PriceByCurrency = Partial<Record<SupportedCurrency, number>>;

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
	/** Per-period unit for in-app math, in MINOR units per currency — per **seat** when
	 *  `perSeat`, flat otherwise. Absent = custom / "Let's talk" (Enterprise). Keep in step
	 *  with `priceLabel`; the EUR figure is tuned independently of the USD one. */
	priceMonthly?: PriceByCurrency;
	/** Whether `priceMonthly` is multiplied by the seat count (per-seat billing). */
	perSeat?: boolean;
	/** Monthly usage credit included with the plan, MINOR units per currency — offsets
	 *  metered charges. */
	includedCredit?: PriceByCurrency;
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
		priceMonthly: { usd: 0, eur: 0 },
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
		priceMonthly: { usd: 2000, eur: 1800 },
		perSeat: true,
		includedCredit: { usd: 2000, eur: 1800 },
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
				detail: "$20/mo toward metered runner-minutes",
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

/**
 * The plan's per-unit charge in the smallest currency unit (cents) — what Stripe's
 * `unit_amount` expects — for the given currency (default USD). Derived from the catalog
 * SSOT (`priceMonthly`) so the created Stripe price can never drift from the advertised one.
 * Throws for custom/free plans with no numeric price (Enterprise).
 *
 * A LOOKUP AND NO ARITHMETIC since #4176 part (b): `priceMonthly` holds minor units, so this
 * reads the number rather than deriving it. The `Math.round(amount * 100)` it used to carry was
 * the first of four copies of that conversion, and the one that fed Stripe.
 */
export function planUnitAmountCents(
	plan: PlanId,
	currency: SupportedCurrency = "usd",
): number {
	const amount = planMeta(plan).priceMonthly?.[currency];
	if (amount == null) {
		throw new Error(`Plan "${plan}" has no ${currency.toUpperCase()} price.`);
	}
	return amount;
}

/** The plan's monthly included usage credit in minor units for `currency` (0 when none). */
export function planIncludedCreditCents(
	plan: PlanId,
	currency: SupportedCurrency = "usd",
): number {
	return planMeta(plan).includedCredit?.[currency] ?? 0;
}

// ── Currency resolution (shared by the console billing flow + the marketing pricing page) ──

/** EU + EEA country codes billed in EUR (ISO 3166-1 alpha-2). */
export const EU_COUNTRIES: ReadonlySet<string> = new Set([
	// EU
	"AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU",
	"IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE",
	// EEA (euro-adjacent) — bill in EUR too
	"IS", "LI", "NO",
]);

/** The billing currency for a country code — EUR for the EU/EEA, USD otherwise. */
export function resolveCurrency(country?: string | null): SupportedCurrency {
	const cc = country?.trim().toUpperCase();
	return cc && EU_COUNTRIES.has(cc) ? "eur" : "usd";
}

// ── Standalone AI product catalog ──────────────────────────────────────────────────
// AI is a SEPARATE metered product from the org plan (Hobby/Pro/Enterprise): everyone
// gets a usable free allowance (AI Free), and AI Plus / AI Max are their own subscription
// that raises the session/weekly limits + deepens what Elench can do. Display copy only —
// the authoritative allowances live in the console (lib/billing/ai-plan.ts `AI_TIERS`) and
// the charge amount in Stripe (STRIPE_PRICE_AI_*). Kept structurally identical to the
// console's `AiTier` union so it stays a zero-dependency package.
//
// Copy rule: NO model names (Sonnet/Opus/executor) — tiers are described by what Elench
// does for the user, never by which model serves it (guarded by the package tests).
//
// Prices below (USD + EUR) are the FINAL maintainer-approved customer amounts (AI Plus
// $20/€18, AI Max $100/€90). They drive display + Stripe provisioning; the cost-of-serve
// (lib/billing/model-costs.ts) remains the authoritative per-model cost basis.

/** The standalone AI tiers, matching the console's `AiTier` union (lib/billing/ai-plan.ts). */
export type AiPlanId = "ai_free" | "ai_plus" | "ai_max";

/** Display copy for one AI tier — never raw credit numbers (proportions/tier only). */
export interface AiPlanCatalogEntry {
	id: AiPlanId;
	name: string;
	/** Display price (the authoritative amount is the Stripe AI price). `undefined` = free. */
	priceLabel: string;
	/** Monthly amount in MINOR units per currency (the Stripe-provisioning SSOT). `0` = free. */
	priceMonthly?: PriceByCurrency;
	tagline: string;
	/** Whether this tier is a paid AI subscription (has a Stripe price). */
	paid: boolean;
	/** What this tier's Elench does for you, in one line (no model names). */
	advisor: string;
	/** Short punchy highlights for the AI upgrade UI. */
	highlights: string[];
	/** The tier the upgrade UI should visually recommend (at most one). */
	recommended?: boolean;
}

export const AI_PLAN_CATALOG: AiPlanCatalogEntry[] = [
	{
		id: "ai_free",
		name: "AI Free",
		priceLabel: "Free",
		priceMonthly: { usd: 0, eur: 0 },
		tagline: "Included with every workspace.",
		paid: false,
		advisor: "Everyday help from Elench",
		highlights: [
			"Session + weekly AI allowance",
			"Repo scans, agent & Ask AI",
			"Upgrade any time for higher limits",
		],
	},
	{
		id: "ai_plus",
		name: "AI Plus",
		priceLabel: "$20 / mo",
		priceMonthly: { usd: 2000, eur: 1800 },
		tagline: "For teams that work with Elench every day.",
		paid: true,
		advisor: "Deeper planning and review",
		recommended: true,
		highlights: [
			"Much higher session and weekly limits",
			"Deeper planning and review on every request",
			"Top-up credit packs when you need more",
		],
	},
	{
		id: "ai_max",
		name: "AI Max",
		priceLabel: "$100 / mo",
		priceMonthly: { usd: 10000, eur: 9000 },
		tagline: "Our most capable Elench, with the most room to work.",
		paid: true,
		advisor: "Deep reasoning on demand",
		highlights: [
			"5× the limits of AI Plus",
			"Deep reasoning on demand for the hardest changes",
			"Top-up credit packs when you need more",
		],
	},
];

/** The paid AI tiers, in upgrade order (the AI upgrade UI). */
export const PAID_AI_PLANS = AI_PLAN_CATALOG.filter((p) => p.paid);

/** Catalog copy for an AI tier (falls back to AI Free — the first entry). */
export function aiPlanMeta(tier: AiPlanId): AiPlanCatalogEntry {
	const found = AI_PLAN_CATALOG.find((p) => p.id === tier);
	if (found) return found;
	const [free] = AI_PLAN_CATALOG;
	if (!free) throw new Error("AI_PLAN_CATALOG is empty");
	return free;
}

/**
 * The AI tier's per-month charge in the smallest currency unit (cents) for the given
 * currency (default USD) — what Stripe's `unit_amount` expects. Sourced from the catalog
 * SSOT (`priceMonthly`) so the provisioned Stripe AI price never drifts from the advertised
 * one. Throws for the free tier (no numeric price).
 */
export function aiPlanUnitAmountCents(
	tier: AiPlanId,
	currency: SupportedCurrency = "usd",
): number {
	const amount = aiPlanMeta(tier).priceMonthly?.[currency];
	if (amount == null) {
		throw new Error(`AI tier "${tier}" has no ${currency.toUpperCase()} price.`);
	}
	return amount;
}

// ── Live-price formatting ────────────────────────────────────────────────────────
// The authoritative price amount lives in Stripe; both the console and the marketing
// site read it live and render it with these shared helpers (so a "$29 / seat / mo"
// label is formatted identically everywhere). The catalog's priceLabel/priceMonthly
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

/**
 * "$29" — whole amounts drop the cents, fractional amounts keep two decimals.
 *
 * NOT `@repo/format`'s `formatMoney`, and not a duplicate of it either: this is a compact price
 * LABEL that deliberately drops `.00`, where that one is a billing-table amount that deliberately
 * never does. Two registers, and until #4176's part (b) they also shared a NAME, which is what
 * made the difference invisible at a call site — `formatMoney` imported from `@repo/plan-catalog`
 * and `formatMoney` imported from `@repo/format` read identically and answer differently. Hence
 * `formatPriceLabel`: the register is now in the name.
 *
 * ── #4096, AND WHAT IS ACTUALLY TRUE ABOUT THE `/ 100` ───────────────────────────────────────
 *
 * The doc that stood here until part (b) said this function "carries #3581's divisor defect,
 * unfixed", because "`currency` is a `string` fed straight from a live Stripe `Price`". That was
 * FALSE WHEN WRITTEN and the signature one line below it says so: the parameter is
 * `SupportedCurrency`, not `string`, and every caller narrows through `asSupportedCurrency` before
 * it gets here. `"usd"` and `"eur"` are both two-decimal for a Stripe CHARGE, so the unconditional
 * `/ 100` is correct for EVERY input this function's type admits — not unreachable-in-practice,
 * which is what the old text claimed, but right.
 *
 * WHAT WOULD MAKE IT WRONG is widening `SupportedCurrency` to a zero-decimal code (JPY, KRW) or a
 * three-decimal one (BHD). That is a real possibility — the maintainer's step-6 ruling on #4176 is
 * "render any currency Stripe returns as-is" — so the claim is now ENFORCED rather than asserted:
 * `apps/console/tests/lib/billing/supported-currency-divisor.test.ts` asserts
 * `stripeChargeDivisor(c) === 100` for every member of `SupportedCurrency`, and goes red on the
 * commit that widens the union rather than on the invoice that renders 100x wrong. The console is
 * where that test lives because the console is the one workspace that depends on BOTH packages.
 *
 * THE DIVISOR IS STILL NOT SHARED, deliberately. Taking `stripeChargeDivisor` from `@repo/format`
 * needs `@repo/plan-catalog` to gain a runtime dependency it has never had, which rewrites
 * `pnpm-lock.yaml`; transcribing Stripe's table a second time here is the failure mode
 * `packages/format/src/minor-units.ts` exists to prevent. The test above buys the safety without
 * buying either.
 *
 * @param unitAmountCents the amount in MINOR units, as `priceMonthly` and Stripe hold it.
 * @param currency one of the currencies the product sells in.
 */
export function formatPriceLabel(unitAmountCents: number, currency: SupportedCurrency): string {
	const symbol = CURRENCY_SYMBOL[currency] ?? `${currency.toUpperCase()} `;
	const amount = unitAmountCents / 100;
	const value = Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
	return `${symbol}${value}`;
}

/** Format a Stripe price (MINOR units) into a per-seat label like "$29 / seat / mo". */
export function formatSeatPrice(
	unitAmountCents: number,
	currency: SupportedCurrency,
	interval: string | undefined | null,
): string {
	return `${formatPriceLabel(unitAmountCents, currency)} / seat / ${shortInterval(interval)}`;
}
