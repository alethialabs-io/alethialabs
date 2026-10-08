// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Payment holds (ADR 0002 §4.1, S4, #5755). One row says that one create-a-team subscription, which
// the flow touched, is not yet proven settled. While a row is open (any state but `released`) it is
// meant to block its payer's next create-a-team purchase. This slice adds the table and its store
// (lib/billing/payment-holds/store.ts) only: NOTHING writes or reads a hold yet. From S5 the
// create-a-team flow opens and advances holds; the webhook nudge and the sweeper come in later slices.
//
// Rows are never deleted (I6): `released` is terminal for a row and kept for audit, and a later open on
// the same subscription writes a NEW row. That is why `subscription_id` is unique among OPEN rows only
// (C51): a plain unique constraint would turn an operator release of a still-`incomplete` subscription
// into a dead end, since the next open on it would conflict with the released row forever.
//
// THREE KINDS OF WRITE (§4.1), and only the store makes them:
//   - a state write changes state, counters and schedule. It is a compare-and-set on `version` AND on
//     the payer's purchase lease (`purchase_leases`, S2) in the same statement, and bumps `version`;
//   - a hint write (the webhook's nudge) sets `nudged_at` and `updated_at` and nothing else;
//   - a notice claim sets `notified_state` and `notified_at` and nothing else.
// Only state writes touch `version`, so a hint or a claim can never make a state write miss (C74).
//
// TENANCY. Service-role only: RLS is enabled with NO app policy (programmables.sql), the
// purchase_leases / cli_logins idiom. A hold is about money across users and the operator; no user
// reads their own rows through the app role. There is no FK on `payer_key` or on any user id: a hold
// outlives the user's account.

import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/** The states a hold can be in (§3.1). Every one but `released` is open and has a `next_check_at`. */
export const PAYMENT_HOLD_STATES = [
	"closing",
	"cancel_unproven",
	"payment_in_flight",
	"invoice_payable",
	"refund_due",
	"refund_pending",
	"needs_operator",
	"released",
] as const;

/** A hold's state (§3.1). */
export type PaymentHoldState = (typeof PAYMENT_HOLD_STATES)[number];

/** Every state but `released`: the ones a hold is open in. */
export type OpenPaymentHoldState = Exclude<PaymentHoldState, "released">;

/** Why a hold was released (§3.1). Only `adopted` leaves the hold's setup open (§4.1). */
export const PAYMENT_HOLD_RELEASE_REASONS = [
	"voided_unpaid",
	"deleted_draft",
	"refunded",
	"already_refunded",
	"adopted",
	"expired_unpaid",
	"operator",
] as const;

/** A hold's `release_reason` (§3.1). */
export type PaymentHoldReleaseReason = (typeof PAYMENT_HOLD_RELEASE_REASONS)[number];

/** Who opened a hold (§4.1): the create-a-team purchase, the §8 backfill, or the link's refusal. */
export const PAYMENT_HOLD_OPENERS = ["purchase", "backfill", "link"] as const;

/** A hold's `opened_by`. */
export type PaymentHoldOpener = (typeof PAYMENT_HOLD_OPENERS)[number];

/** The states whose customer email can be claimed (§4.1, Q3). */
export const PAYMENT_HOLD_NOTIFIED_STATES = ["refund_pending", "released:refunded", "released:adopted"] as const;

/** A hold's `notified_state`. */
export type PaymentHoldNotifiedState = (typeof PAYMENT_HOLD_NOTIFIED_STATES)[number];

/** `'a', 'b', …` for a CHECK constraint's IN list, from one of the value lists above. */
function sqlList(values: readonly string[]): string {
	return values.map((v) => `'${v}'`).join(", ");
}

export const paymentHolds = pgTable(
	"payment_holds",
	{
		id: uuid().primaryKey().defaultRandom(),
		// The create-a-team subscription this hold is about (`sub_…`). Unique among OPEN rows only.
		subscription_id: text().notNull(),
		customer_id: text().notNull(),
		// The payer: the user id (I12). Written once, at open, and never changed — a hold keeps blocking
		// its payer after the subscription is linked to an org.
		payer_key: text().notNull(),
		// The held invoice (I2): `latest_invoice` when the hold was opened. The only invoice a hold reads,
		// voids or refunds — never the subscription's later invoices.
		invoice_id: text().notNull(),
		payment_intent_id: text(),
		state: text().$type<PaymentHoldState>().notNull(),
		release_reason: text().$type<PaymentHoldReleaseReason>(),
		released_at: timestamp({ withTimezone: true }),
		// A user id for an operator release, null for the system.
		released_by: text(),
		release_note: text(),
		// The refund idempotency key's attempt number (§3.5). Reserved by a state write BEFORE each refund.
		refund_attempt: integer().notNull().default(0),
		attempts: integer().notNull().default(0),
		last_error: text(),
		next_check_at: timestamp({ withTimezone: true }),
		alerted_at: timestamp({ withTimezone: true }),
		// When a response last CARRIED this hold's clause. It never means "delivered".
		notice_last_sent_at: timestamp({ withTimezone: true }),
		// The state whose email has been CLAIMED for sending, and when (rev 7, Q3). Null when no email
		// was claimed. Written only by the notice claim.
		notified_state: text().$type<PaymentHoldNotifiedState>(),
		notified_at: timestamp({ withTimezone: true }),
		opened_by_user_id: text(),
		opened_by: text().$type<PaymentHoldOpener>().notNull(),
		open_note: text(),
		state_since: timestamp({ withTimezone: true }).defaultNow().notNull(),
		// The pay classification of the last successful observation (§3.2).
		last_pay: text(),
		refund_action_since: timestamp({ withTimezone: true }),
		age_alerted_at: timestamp({ withTimezone: true }),
		// When the observation behind the last state write STARTED. The open sets it to the insert time.
		observed_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
		// The webhook's hint. A hold is due when `next_check_at <= now()` or `nudged_at > observed_at`.
		nudged_at: timestamp({ withTimezone: true }),
		// The STATE version: bumped by state writes only.
		version: integer().notNull().default(0),
		created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
		updated_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [
		// I6 + C51: at most one OPEN hold per subscription; released rows do not count.
		uniqueIndex("payment_holds_open_subscription_uidx")
			.on(t.subscription_id)
			.where(sql`state <> 'released'`),
		// The create-a-team flow reads its payer's open holds.
		index("payment_holds_open_payer_idx")
			.on(t.payer_key)
			.where(sql`state <> 'released'`),
		check("payment_holds_state_known", sql.raw(`state IN (${sqlList(PAYMENT_HOLD_STATES)})`)),
		check(
			"payment_holds_release_reason_known",
			sql.raw(`release_reason IS NULL OR release_reason IN (${sqlList(PAYMENT_HOLD_RELEASE_REASONS)})`),
		),
		check("payment_holds_opened_by_known", sql.raw(`opened_by IN (${sqlList(PAYMENT_HOLD_OPENERS)})`)),
		check(
			"payment_holds_notified_state_known",
			sql.raw(`notified_state IS NULL OR notified_state IN (${sqlList(PAYMENT_HOLD_NOTIFIED_STATES)})`),
		),
		// A released row says why and when; an open row says neither.
		check(
			"payment_holds_release_shape",
			sql`(state = 'released') = (release_reason IS NOT NULL AND released_at IS NOT NULL)`,
		),
		// I10: every open hold is scheduled.
		check("payment_holds_open_is_scheduled", sql`state = 'released' OR next_check_at IS NOT NULL`),
	],
);

export type PaymentHoldRow = typeof paymentHolds.$inferSelect;
