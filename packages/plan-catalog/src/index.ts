// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
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

/** Currencies we present + charge in. USD is the default; EU customers are billed in EUR. */
export type SupportedCurrency = "usd" | "eur";

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
	/** Per-period EUR unit (FX-adjusted from USD; billed to EU customers). Same shape as
	 *  `priceMonthlyUsd`; `undefined` = custom. Tune independently of the USD figure. */
	priceMonthlyEur?: number;
	/** Whether `priceMonthlyUsd` is multiplied by the seat count (per-seat billing). */
	perSeat?: boolean;
	/** Monthly usage credit (USD) included with the plan — offsets metered charges. */
	includedCreditUsd?: number;
	/** Same included usage credit, in EUR (for EU-billed customers). */
	includedCreditEur?: number;
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
		priceMonthlyEur: 0,
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
		priceMonthlyEur: 18,
		perSeat: true,
		includedCreditUsd: 20,
		includedCreditEur: 18,
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
 * SSOT (`priceMonthlyUsd` / `priceMonthlyEur`) so the created Stripe price can never drift
 * from the advertised one. Throws for custom/free plans with no numeric price (Enterprise).
 */
export function planUnitAmountCents(
	plan: PlanId,
	currency: SupportedCurrency = "usd",
): number {
	const meta = planMeta(plan);
	const amount = currency === "eur" ? meta.priceMonthlyEur : meta.priceMonthlyUsd;
	if (amount == null) {
		throw new Error(`Plan "${plan}" has no ${currency.toUpperCase()} price.`);
	}
	return Math.round(amount * 100);
}

/** The plan's monthly included usage credit in cents (0 when none). */
export function planIncludedCreditCents(plan: PlanId): number {
	return Math.round((planMeta(plan).includedCreditUsd ?? 0) * 100);
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

/**
 * `code` as a currency we present and charge in, or `null`.
 *
 * The narrowing a caller holding a live Stripe `Price.currency` — a bare `string` — has to perform
 * before it can reach {@link formatSeatPrice}. It returns `null` rather than defaulting to `"usd"`
 * on purpose: a price quoted in a currency this product does not sell in is not a USD price, and
 * rendering it as one is the whole of #4096. The caller decides what to do instead, and the answer
 * is visible at the call site rather than buried in a formatter.
 *
 * Case- and whitespace-insensitive because Stripe spells a currency in lower case and ISO 4217 in
 * upper, and both reach this function.
 */
export function asSupportedCurrency(code: string | null | undefined): SupportedCurrency | null {
	const c = code?.trim().toLowerCase();
	return c === "usd" || c === "eur" ? c : null;
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
	/** Monthly USD amount (the Stripe-provisioning SSOT). `0` = free. */
	priceMonthlyUsd?: number;
	/** Monthly EUR amount (for EU-billed customers). Keep in step with the USD figure. */
	priceMonthlyEur?: number;
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
		priceMonthlyUsd: 0,
		priceMonthlyEur: 0,
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
		priceMonthlyUsd: 20,
		priceMonthlyEur: 18,
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
		priceMonthlyUsd: 100,
		priceMonthlyEur: 90,
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
 * SSOT (`priceMonthlyUsd` / `priceMonthlyEur`) so the provisioned Stripe AI price never
 * drifts from the advertised one. Throws for the free tier (no numeric price).
 */
export function aiPlanUnitAmountCents(
	tier: AiPlanId,
	currency: SupportedCurrency = "usd",
): number {
	const meta = aiPlanMeta(tier);
	const amount = currency === "eur" ? meta.priceMonthlyEur : meta.priceMonthlyUsd;
	if (amount == null) {
		throw new Error(`AI tier "${tier}" has no ${currency.toUpperCase()} price.`);
	}
	return Math.round(amount * 100);
}

// ── Live-price formatting ────────────────────────────────────────────────────────
// The authoritative price amount lives in Stripe; the MARKETING site reads it live and
// renders it with the helpers below. The catalog's priceLabel/priceMonthlyUsd are the
// FALLBACK used only when Stripe isn't configured / the lookup fails.
//
// THE CONSOLE NO LONGER FORMATS MONEY HERE (#4096). It renders every amount through
// `@repo/format`, which owns Stripe's charge-divisor table — a dependency the console
// already had and marketing cannot take. The console's own billing surfaces disagreed
// about this while both registers were live: its checkout form has rendered `$29.00`
// since it dropped its private `money()` for the same reason, while its plan cards said
// `$29`. They agree now.

/**
 * The symbol for each currency we sell in.
 *
 * TOTAL over `SupportedCurrency`, so indexing it needs no `??` fallback. It used to carry a `gbp`
 * row and fall back to `"<CODE> "` for anything else, which is what let an arbitrary Stripe
 * currency string reach the divisor below (#4096). The type is the guard now; a code that does not
 * narrow never gets here.
 */
const CURRENCY_SYMBOL: Record<SupportedCurrency, string> = {
	usd: "$",
	eur: "€",
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
 * PRIVATE, and the un-exporting is half of #4096's fix. This used to be exported as `formatMoney`,
 * which put a SECOND function of that name in the workspace beside `@repo/format`'s. There is one
 * exported `formatMoney` in this repo again.
 *
 * WHAT WAS WRONG: the `/ 100` was unconditional and `currency` was a bare `string` taken straight
 * off a live Stripe `Price`, so a zero-decimal price would have rendered at 1/100 of its value —
 * the defect #3581 fixed in `@repo/format` by giving it Stripe's charge table.
 *
 * WHY THE `/ 100` IS STILL HERE AND IS NOW CORRECT: `currency` is `SupportedCurrency`, and
 * `stripeChargeDivisor` in `packages/format/src/minor-units.ts` answers 100 for both `usd` and
 * `eur`. The division is total on its declared domain rather than merely unreached, and a third
 * currency cannot join that union without this line coming back into review. The TYPE holds the
 * invariant; a comment would not.
 *
 * WHY THIS FUNCTION SURVIVES AT ALL: it is a different REGISTER, not a duplicate. A compact price
 * label that deliberately drops `.00` (`$29 / seat / mo`), where `@repo/format`'s is a billing-table
 * amount that deliberately never does (`$29.00`). Its only remaining reader is `apps/marketing`,
 * which cannot import `@repo/format`: that package exports raw TypeScript and is absent from
 * marketing's `transpilePackages` (`apps/marketing/next.config.ts`), and it carries `date-fns`, so
 * the edge would also destroy this package's stated zero-runtime-dependency property. Every console
 * caller was converted to `@repo/format` instead, which needed no new dependency at all.
 */
function compactAmount(unitAmountMinor: number, currency: SupportedCurrency): string {
	const amount = unitAmountMinor / 100;
	const value = Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
	return `${CURRENCY_SYMBOL[currency]}${value}`;
}

/**
 * A Stripe per-seat price as a compact label — `$29 / seat / mo`.
 *
 * `currency` is `SupportedCurrency` rather than `string`, which is the other half of #4096's fix: a
 * caller holding a live Stripe `Price.currency` must narrow it with {@link asSupportedCurrency} and
 * say what happens when it does not narrow, instead of handing an unknown currency to a divisor
 * that assumes two decimal places.
 *
 * @param unitAmountMinor the amount in the currency's minor units, as Stripe quotes a charge.
 */
export function formatSeatPrice(
	unitAmountMinor: number,
	currency: SupportedCurrency,
	interval: string | undefined | null,
): string {
	return `${compactAmount(unitAmountMinor, currency)} / seat / ${shortInterval(interval)}`;
}
