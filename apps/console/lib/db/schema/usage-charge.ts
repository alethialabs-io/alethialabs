// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The overage ledger: one row per usage charge we post (or decide not to post) against a
// subscription for a billing period. With Paddle there is no metered price — our own runner-minute
// meter computes the overage and a sweeper posts ONE non-catalog charge per period shortly before
// it ends (L5). Paddle has no idempotency key, so the row is the idempotency: the sweeper CLAIMS a
// row (status `claimed`) before calling the provider, and the unique key
// (provider, subscription_id, period_start, sequence) makes a second claim for the same period
// impossible. `sequence` exists for the rare second charge in one period (a final-cancellation
// charge after the regular one); it is chosen by the writer, never inferred.
//
// Written only by the service role; members read their own org's rows (RLS in programmables.sql).

import { sql } from "drizzle-orm";
import {
	check,
	index,
	integer,
	pgTable,
	text,
	timestamp,
	unique,
	uuid,
} from "drizzle-orm/pg-core";
import { type BillingProviderId, billingProviderSqlList } from "./billing-provider";
import { organization } from "./organizations";

/**
 * Where a usage charge stands: `claimed` = the row is held, the provider not yet called (or the
 * call's outcome unknown — reconcile before retrying); `posted` = the provider accepted the charge;
 * `reconciled` = it was found on the provider's next transaction; `failed` = the provider refused
 * it; `waived` = deliberately not charged (below the minimum, operator decision).
 */
export const USAGE_CHARGE_STATUSES = ["claimed", "posted", "reconciled", "failed", "waived"] as const;

/** One of `USAGE_CHARGE_STATUSES`. */
export type UsageChargeStatus = (typeof USAGE_CHARGE_STATUSES)[number];

/** `'a', 'b', …` for a CHECK constraint's IN list, from a closed list of literals declared here. */
function sqlList(values: readonly string[]): string {
	return values.map((v) => `'${v}'`).join(", ");
}

export const usageCharge = pgTable(
	"usage_charge",
	{
		id: uuid().primaryKey().defaultRandom(),
		organizationId: uuid()
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		provider: text().$type<BillingProviderId>().notNull(),
		/** The provider's subscription id the charge is posted against. */
		subscriptionId: text().notNull(),
		/** The billing period the overage was measured over. */
		periodStart: timestamp({ withTimezone: true }).notNull(),
		periodEnd: timestamp({ withTimezone: true }).notNull(),
		/** 0 for the period's regular charge; the writer picks 1, 2, … for any further one. */
		sequence: integer().default(0).notNull(),
		/** Runner minutes over the plan's included allowance, as measured. */
		overageMinutes: integer().notNull(),
		/** The amount charged (or that would have been), in the currency's minor unit. */
		amountMinor: integer().notNull(),
		currency: text().notNull(),
		status: text().$type<UsageChargeStatus>().default("claimed").notNull(),
		/** The provider's reference once known (Paddle: the transaction that carries the charge). */
		providerRef: text(),
		/** The provider's refusal, or why it was waived. */
		error: text(),
		claimedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
		postedAt: timestamp({ withTimezone: true }),
		createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [
		unique("usage_charge_period_sequence_unique").on(
			t.provider,
			t.subscriptionId,
			t.periodStart,
			t.sequence,
		),
		index("usage_charge_org_idx").on(t.organizationId),
		check("usage_charge_provider_known", sql.raw(`provider IN (${billingProviderSqlList()})`)),
		check(
			"usage_charge_status_known",
			sql.raw(`status IN (${sqlList(USAGE_CHARGE_STATUSES)})`),
		),
		check("usage_charge_amounts_non_negative", sql`overage_minutes >= 0 AND amount_minor >= 0`),
		check("usage_charge_sequence_non_negative", sql`sequence >= 0`),
		check("usage_charge_period_ordered", sql`period_end > period_start`),
	],
);

export type UsageCharge = typeof usageCharge.$inferSelect;
export type UsageChargeInsert = typeof usageCharge.$inferInsert;
