// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Payment holds (ADR 0002 §4.1, S4, #5755; ADR 0004 D1). One row says that one subscription, which a
// purchase flow touched, is not yet proven settled. A row is open in any state but `released`. The
// create-a-team purchase (app/server/actions/billing.ts) reads its payer's `new_org` holds
// (`paymentHoldsOfPayer`, lib/billing/pending-org-setup.ts), advances each open one, and refuses to mint
// while any of them blocks: every open state but `refund_pending` (`holdBlocks`,
// lib/billing/new-org-hold-copy.ts).
//
// SCOPE (ADR 0004 D1). Every hold belongs to one flow: `new_org` (create-a-team, payer = the user id) or
// `org_plan` (the org-plan purchase, payer = the org id). The pair `(scope, payer_key)` is the key, and
// `leaseKeyFor` names the purchase lease that fences the hold's state writes, and throws on a scope it has
// no lease prefix for (#6009). Every opener today is
// create-a-team and passes no scope, so the column's default `new_org` labels them; ADR 0004 O8 drops
// the default once every opener passes it.
//
// Every write goes through lib/billing/payment-holds/store.ts, whose header names its callers: the
// purchase, the link, the sweeper, the webhook's nudge, the notice stamp, the notice emails and the
// operator command.
//
// Rows are never deleted (I6): `released` is terminal for a row and kept for audit, and a later open on
// the same subscription writes a NEW row. That is why `subscription_id` is unique among OPEN rows only
// (C51): a plain unique constraint would turn an operator release of a still-`incomplete` subscription
// into a dead end, since the next open on it would conflict with the released row forever.
//
// THREE KINDS OF WRITE (§4.1), and only the store makes them:
//   - a state write changes state, counters and schedule. It is a compare-and-set on `version` AND on
//     the payer's purchase lease (`purchase_leases`, S2) in the same statement, and bumps `version`;
//   - a hint write sets one hint column and nothing else: the webhook's nudge sets `nudged_at` and
//     `updated_at`; the notice stamp (`stampHoldNotice`, #6029) sets `notice_last_sent_at` alone, with
//     no lease and no state predicate, so it stamps a `released` hold too;
//   - a notice claim sets `notified_state` and `notified_at` and nothing else;
//   - the relink write (`writeAdoptedRelinkState`, ADR 0002 §4.1 amendment 2026-10-14, #6078) is the one
//     write on a RELEASED row: on a `new_org` hold released `adopted` only, it sets `attempts`,
//     `last_error`, `next_check_at` and `alerted_at` for the retries of its setup's relink, fenced and
//     bumping `version` as a state write is.
// Only state writes and the relink write touch `version`, so a hint or a claim can never make either
// miss (C74).
//
// `next_check_at` on a RELEASED row is null, except on a `new_org` hold released `adopted`: there it is
// when the sweeper's relink pass next retries the relink of the hold's open setup (#6078), and null once
// that relink is decided.
//
// TENANCY. Service-role only: RLS is enabled with NO app policy (programmables.sql), the
// purchase_leases / cli_logins idiom. A hold is about money across users and the operator; no user
// reads their own rows through the app role. There is no FK on `payer_key` or on any user id: a hold
// outlives the user's account.

import { type SQL, sql } from "drizzle-orm";
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

/** The flows a hold can belong to (ADR 0004 D1). Written at open and never changed (ADR 0004 O2). */
export const PAYMENT_HOLD_SCOPES = ["new_org", "org_plan"] as const;

/** A hold's `scope`. */
export type PaymentHoldScope = (typeof PAYMENT_HOLD_SCOPES)[number];

/**
 * The purchase-lease key prefix of each scope: a `new_org` hold is fenced on its payer user's lease, an
 * `org_plan` hold on its org's (ADR 0004 §2 "Lease key"). `leaseKeyFor` and the store's SQL fence
 * (`leaseKeySql`) are both built from this one table, so they cannot name different leases.
 */
const LEASE_KEY_PREFIX: Readonly<Record<PaymentHoldScope, string>> = {
	new_org: "user:",
	org_plan: "org-plan:",
};

/**
 * The purchase-lease key that fences the state writes of a hold in `scope` whose payer is `payerKey`.
 * A scope with no prefix (a value that reached here untyped) throws rather than name a lease.
 */
export function leaseKeyFor(scope: PaymentHoldScope, payerKey: string): string {
	const prefix: string | undefined = LEASE_KEY_PREFIX[scope];
	if (prefix === undefined) throw new Error(`leaseKeyFor: ${String(scope)} is not a payment-hold scope.`);
	return `${prefix}${payerKey}`;
}

/**
 * `leaseKeyFor(scope, payer_key)` as a SQL expression over a `payment_holds` row, for use inside a
 * statement on that table. A row whose scope is none of `PAYMENT_HOLD_SCOPES` (the scope check refuses
 * one) would yield NULL, which matches no lease.
 */
export function leaseKeySql(): SQL {
	const arms = PAYMENT_HOLD_SCOPES.map(
		(scope) => sql`WHEN ${sql.raw(`'${scope}'`)} THEN ${sql.raw(`'${LEASE_KEY_PREFIX[scope]}'`)}`,
	);
	return sql`((CASE payment_holds.scope ${sql.join(arms, sql` `)} END) || payment_holds.payer_key)`;
}

/** `'a', 'b', …` for a CHECK constraint's IN list, from one of the value lists above. */
function sqlList(values: readonly string[]): string {
	return values.map((v) => `'${v}'`).join(", ");
}

export const paymentHolds = pgTable(
	"payment_holds",
	{
		id: uuid().primaryKey().defaultRandom(),
		// The subscription this hold is about (`sub_…`). Unique among OPEN rows only, across every scope.
		subscription_id: text().notNull(),
		customer_id: text().notNull(),
		// The flow this hold belongs to (ADR 0004 D1). Written once, at open, and never changed. The
		// default carries the existing rows and the openers that pass no scope; ADR 0004 O8 drops it.
		scope: text().$type<PaymentHoldScope>().notNull().default("new_org"),
		// The payer in `scope`: the user id for `new_org` (I12), the org id for `org_plan`. Written once, at
		// open, and never changed. `payer_key` alone is never a key: the create-a-team purchase reads a
		// payer's holds by `(new_org, payer_key)` (`paymentHoldsOfPayer`), whether or not the subscription
		// has since been linked to an org.
		payer_key: text().notNull(),
		// The held invoice (I2): `latest_invoice` when the hold was opened. It is the only invoice the
		// machine reads, voids or deletes, and the only one whose PaymentIntents it refunds — never the
		// subscription's later invoices.
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
		// For the lookup of a payer's open holds, which is always by scope and payer (ADR 0004 D1).
		index("payment_holds_open_payer_idx")
			.on(t.scope, t.payer_key)
			.where(sql`state <> 'released'`),
		check("payment_holds_scope_known", sql.raw(`scope IN (${sqlList(PAYMENT_HOLD_SCOPES)})`)),
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
