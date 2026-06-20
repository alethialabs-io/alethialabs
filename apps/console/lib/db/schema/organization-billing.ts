// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
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
	integer,
	pgTable,
	text,
	timestamp,
	uuid,
} from "drizzle-orm/pg-core";
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
	// End of the current paid period — entitlements lapse to community after this
	// if the subscription isn't renewed (defence-in-depth alongside `status`).
	currentPeriodEnd: timestamp({ withTimezone: true }),
	createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
	updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
});

export type OrganizationBilling = typeof organizationBilling.$inferSelect;
export type OrganizationBillingInsert = typeof organizationBilling.$inferInsert;
