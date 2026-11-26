// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Per-organization billing record — the source of truth for an org's paid plan and
// subscription state. Kept SEPARATE from better-auth's `organization` table (which
// must stay matching the plugin's expected shape) because billing is a commercial
// concern: the entitlement seam (lib/authz/entitlements.ts) resolves an org's plan
// from here → planEntitlements() decides which enterprise features are unlocked.
//
// One row per org (org_id unique). An org with NO row is implicitly `community`
// (all enterprise features off) — so the community/self-host build, which never
// writes this table, behaves exactly as before. The row is written by the hosted
// Stripe webhook (F2) or a signed self-managed license (F3).

import { sql } from "drizzle-orm";
import {
	boolean,
	check,
	index,
	integer,
	pgTable,
	text,
	timestamp,
	uuid,
} from "drizzle-orm/pg-core";
import type { AiTier } from "@/lib/billing/ai-plan";
import { type BillingProviderId, billingProviderSqlList } from "./billing-provider";
import { billingPlan, billingStatus, payerCapacity } from "./enums";
import { organization } from "./organizations";

/** The declared VAT-number status of a paying organization. NULL in the column = undeclared. */
export const VAT_ID_STATUSES = ["given", "not_given"] as const;

/** One of `VAT_ID_STATUSES`. */
export type VatIdStatus = (typeof VAT_ID_STATUSES)[number];

/** `'a', 'b', …` for a CHECK constraint's IN list, from a closed list of literals declared here. */
function sqlList(values: readonly string[]): string {
	return values.map((v) => `'${v}'`).join(", ");
}

export const organizationBilling = pgTable("organization_billing", {
	id: uuid().primaryKey().defaultRandom(),
	organizationId: uuid()
		.notNull()
		.unique()
		.references(() => organization.id, { onDelete: "cascade" }),
	plan: billingPlan().default("community").notNull(),
	status: billingStatus().default("none").notNull(),
	// Stripe linkage (null until a checkout completes). Unique so a customer /
	// subscription maps back to exactly one org from webhook events.
	stripeCustomerId: text().unique(),
	stripeSubscriptionId: text().unique(),
	// Stripe's `created` time of the newest event applied for `stripeSubscriptionId` — the
	// out-of-order / redelivery watermark (#5514). An event for the SAME subscription that is
	// older than this is refused by the conditional upsert in lib/billing/queries.ts, so a stale
	// or replayed event cannot regress the row. Null when no event time has been recorded (a row
	// written by a server action or the operator plane, or one that predates the column).
	stripeSubscriptionEventAt: timestamp({ withTimezone: true }),
	// Purchased seats (per-seat Team tier); null for flat tiers / no subscription.
	seats: integer(),
	// Start of the current paid period — the window start for usage metering
	// (job-minutes this period). Null → meter by calendar month.
	currentPeriodStart: timestamp({ withTimezone: true }),
	// End of the current paid period — entitlements lapse to community after this
	// if the subscription isn't renewed (defence-in-depth alongside `status`).
	currentPeriodEnd: timestamp({ withTimezone: true }),
	// When true, the org pauses new jobs at its included allowance instead of
	// billing overage (user-controlled "never surprise me"). Default off.
	usageHardCap: boolean().default(false).notNull(),
	// Standalone AI product state (ORTHOGONAL to `plan` above). `ai_tier` is the AI
	// subscription tier (default `ai_free` — everyone's free allowance); the paid tiers
	// (`ai_plus`/`ai_max`) are their own Stripe subscription, tracked separately from the
	// org-plan subscription so an org can be e.g. Hobby plan + AI Plus. See lib/billing/ai-plan.ts.
	aiTier: text().$type<AiTier>().default("ai_free").notNull(),
	// The Stripe subscription id backing a paid AI tier (null on `ai_free`). Unique so an
	// AI subscription maps back to exactly one org from webhook events.
	aiStripeSubscriptionId: text().unique(),
	// Lifecycle of the AI subscription (mirrors Stripe). Only `trialing`/`active` keep a
	// paid `ai_tier` effective; anything else falls back to `ai_free` (effectiveAiTier).
	aiSubscriptionStatus: billingStatus().default("none").notNull(),
	// The same event-time watermark as `stripeSubscriptionEventAt`, for `aiStripeSubscriptionId`.
	aiStripeSubscriptionEventAt: timestamp({ withTimezone: true }),
	// ── Payment provider (Paddle Billing, L1) ─────────────────────────────────────
	// Which provider this org's subscriptions live with. NULL = never routed explicitly: a row
	// written before this column, or by today's Stripe writers (which do not set it). The seam
	// (lib/billing/provider/select.ts `providerForOrg`) reads NULL as "stripe" when a Stripe
	// subscription id is present, else as the instance's sales provider. A Paddle subscription id
	// REQUIRES `paddle` here (check below) — the Paddle writers are new and always set it.
	billingProvider: text().$type<BillingProviderId>(),
	// Paddle linkage, BESIDE Stripe's (no renames). A Paddle customer is per e-mail address, and
	// Paddle lets one customer own businesses for several orgs, so the customer id is indexed but
	// NOT unique; the business and the subscriptions map back to exactly one org.
	paddleCustomerId: text(),
	paddleBusinessId: text().unique(),
	paddleAddressId: text(),
	paddleSubscriptionId: text().unique(),
	// Paddle's `occurred_at` of the newest event applied for `paddleSubscriptionId` — the same
	// out-of-order / redelivery watermark as `stripeSubscriptionEventAt`.
	paddleSubscriptionEventAt: timestamp({ withTimezone: true }),
	// The Paddle subscription backing a paid AI tier, and its watermark (mirrors the Stripe pair).
	aiPaddleSubscriptionId: text().unique(),
	aiPaddleSubscriptionEventAt: timestamp({ withTimezone: true }),
	// When a scheduled cancellation takes effect (Paddle `scheduled_change.effective_at`). NULL when
	// nothing is scheduled. The subscription stays entitled until this instant.
	cancelEffectiveAt: timestamp({ withTimezone: true }),
	// Admin AI-spend limits (Claude-Enterprise style), in credits/week. NULL = no admin
	// limit → use the tier's default caps. When set, they only ever TIGHTEN the effective
	// budget (min(tier, cap)): an org-wide weekly ceiling and a per-seat weekly ceiling, so
	// an admin can cap total org spend and/or bound any single member. See lib/billing/ai-plan.ts.
	aiOrgWeeklyCapCredits: integer(),
	aiPerUserWeeklyCapCredits: integer(),
	// ── Who pays, declared (#2372) ────────────────────────────────────────────
	// The two facts the paid-conversion gate needs BEFORE an order exists, so they live on the
	// paying entity's row rather than being fished out of Stripe on every check.
	//
	// `payerCapacity` decides WHICH LAW applies — consumer protections attach to one value and not
	// the other — so it is DECLARED by the payer and NULL until they do. Inferring it from whether
	// an address looks like a company would pick the legal regime on a text field, and picking
	// `organization` wrongly strips a real consumer of rights they cannot waive.
	//
	// `billingCountry` is ISO 3166-1 alpha-2. NULL means unknown, and unknown REFUSES the sale —
	// it must never fall back to the seller's own jurisdiction, which is the plausible default that
	// would silently enable the market we are least ready for.
	payerCapacity: payerCapacity(),
	billingCountry: text(),
	// The payer's attestation that they can bind the organization, in their own words (role/title).
	// Null for a consumer, where there is nothing to bind.
	authorityAttestation: text(),
	// ── VAT number and US state, declared (#7321, Early Access) ─────────────────
	// Whether the organization HAS a VAT number decides which paid-market cell it falls in, so it
	// is declared alongside capacity and country. `vatIdStatus` is `given` | `not_given` (a check
	// constraint, not a pg enum: enums.ts is owned elsewhere). NULL means UNDECLARED, and the gate
	// fails closed on it in the EU — it is never read as "no VAT number".
	vatIdStatus: text().$type<VatIdStatus>(),
	// The VAT number itself, as given. Only an organization that declared `given` can hold one
	// (check constraint below): a `not_given` organization records no VAT number at all.
	vatId: text(),
	// USPS two-letter state code for a US payer (the per-state thresholds). NULL outside the US,
	// and NULL for a US payer that has not declared one — which the gate refuses.
	billingState: text(),
	// Set the first time the org reaches a paid plan (trial or paid) — the
	// exactly-once claim for the "welcome to your plan" email, so it never re-sends
	// on renewals/updates (see syncSubscriptionToBilling). Null until first activation.
	welcomedAt: timestamp({ withTimezone: true }),
	// ── Local-trial notices (lib/billing/trial/notices.ts) ─────────────────────────
	// The exactly-once claims for the two emails a LOCAL (Paddle-era, provider-less) trial is sent:
	// the reminder before it ends and the notice once it has. Each holds the trial end
	// (`current_period_end`) the email was claimed for, not a bare "sent" time, so the claim is per
	// TRIAL: a new or extended trial has a different end and is owed its own email, and a retry of
	// the same trial is not. NULL until claimed. A Stripe trial never touches these — Stripe's
	// `trial_will_end` and `subscription.deleted` events drive its emails.
	trialEndingNoticeFor: timestamp({ withTimezone: true }),
	trialEndedNoticeFor: timestamp({ withTimezone: true }),
	createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
	updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
}, (t) => [
	index("organization_billing_paddle_customer_idx").on(t.paddleCustomerId),
	check(
		"organization_billing_provider_known",
		sql.raw(`billing_provider IS NULL OR billing_provider IN (${billingProviderSqlList()})`),
	),
	// A Stripe subscription id belongs to a Stripe row. NULL is admitted because today's Stripe
	// writers predate the column and do not set it (see `billingProvider` above).
	check(
		"organization_billing_stripe_sub_is_stripe",
		sql`(stripe_subscription_id IS NULL AND ai_stripe_subscription_id IS NULL) OR billing_provider IS NULL OR billing_provider = 'stripe'`,
	),
	// A Paddle subscription id belongs to a row that SAYS Paddle — strictly.
	check(
		"organization_billing_paddle_sub_is_paddle",
		sql`(paddle_subscription_id IS NULL AND ai_paddle_subscription_id IS NULL) OR billing_provider = 'paddle'`,
	),
	// One subscription per slot: never a Stripe AND a Paddle subscription for the plan, or for AI.
	check(
		"organization_billing_one_plan_subscription",
		sql`stripe_subscription_id IS NULL OR paddle_subscription_id IS NULL`,
	),
	check(
		"organization_billing_one_ai_subscription",
		sql`ai_stripe_subscription_id IS NULL OR ai_paddle_subscription_id IS NULL`,
	),
	check(
		"organization_billing_vat_id_status_known",
		sql.raw(`vat_id_status IS NULL OR vat_id_status IN (${sqlList(VAT_ID_STATUSES)})`),
	),
	// A VAT number exists only where one was declared.
	check("organization_billing_vat_id_only_when_given", sql`vat_id IS NULL OR vat_id_status = 'given'`),
]);

export type OrganizationBilling = typeof organizationBilling.$inferSelect;
export type OrganizationBillingInsert = typeof organizationBilling.$inferInsert;
