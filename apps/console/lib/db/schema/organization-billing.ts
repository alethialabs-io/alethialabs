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

import {
	boolean,
	integer,
	pgTable,
	text,
	timestamp,
	uuid,
} from "drizzle-orm/pg-core";
import type { AiTier } from "@/lib/billing/ai-plan";
import { billingPlan, billingStatus } from "./enums";
import { organization } from "./organizations";

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
	// Admin AI-spend limits (Claude-Enterprise style), in credits/week. NULL = no admin
	// limit → use the tier's default caps. When set, they only ever TIGHTEN the effective
	// budget (min(tier, cap)): an org-wide weekly ceiling and a per-seat weekly ceiling, so
	// an admin can cap total org spend and/or bound any single member. See lib/billing/ai-plan.ts.
	aiOrgWeeklyCapCredits: integer(),
	aiPerUserWeeklyCapCredits: integer(),
	// Set the first time the org reaches a paid plan (trial or paid) — the
	// exactly-once claim for the "welcome to your plan" email, so it never re-sends
	// on renewals/updates (see syncSubscriptionToBilling). Null until first activation.
	welcomedAt: timestamp({ withTimezone: true }),
	createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
	updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
});

export type OrganizationBilling = typeof organizationBilling.$inferSelect;
export type OrganizationBillingInsert = typeof organizationBilling.$inferInsert;
