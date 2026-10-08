// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The payment-hold store (ADR 0002 §4.1, S4, #5755): the only module that writes `payment_holds`.
//
// NO CALLER YET. This slice adds the table and the writes; from slice 5 the create-a-team flow opens
// holds (E0) and advances them (`advanceHold`), and later slices add the webhook's nudge, the sweeper and
// its notice emails, and the operator's release. Until then no row is ever written outside the tests.
//
// THREE KINDS OF WRITE (§4.1), each with its own fence:
//
//   STATE WRITE   `openHold` (E0), `writeHoldState` (every transition that keeps the hold open, a failed
//                 observation's bookkeeping, the age alert), `reserveRefundAttempt` (T5's reservation,
//                 §3.5) and `releaseHold` (every release, including T16). A compare-and-set on `version`
//                 AND on the payer's purchase lease (S2) in the same statement, `version = version + 1`.
//                 A request whose lease another request took over writes nothing: its statement matches
//                 no row (S2's C25, the hold-write half). A write prepared on a version another write has
//                 since bumped writes nothing either (C65).
//   HINT WRITE    `nudgeHold`: `nudged_at` and `updated_at` only. No version, no bump, no lease.
//   NOTICE CLAIM  `claimHoldNotice` / `unclaimHoldNotice`: `notified_state` and `notified_at` only. No
//                 version, no bump, no lease; its own compare-and-set makes each email at most once per
//                 hold and state.
// Neither a hint nor a claim touches `version`, so neither can make a state write miss (C74).
//
// A RELEASE DECIDES THE SETUP (§4.1, I16 (b)). The state write that releases a hold, for any reason but
// `adopted`, closes the `pending_org_setups` row with the hold's `subscription_id` in the SAME
// transaction (`closed_reason = 'hold_released'`), when that row is still open. An `adopted` release
// leaves it open: from slice 5 its caller re-links the setup, or leaves it open for the resume, after the
// commit (§5.6 "When a hold ends").
//
// Every write runs through getServiceDb(): the table is service-role only (programmables.sql).

import "server-only";
import { and, eq, isNull, ne, type SQL, sql } from "drizzle-orm";
import { getServiceDb } from "@/lib/db";
import {
	type OpenPaymentHoldState,
	type PaymentHoldNotifiedState,
	type PaymentHoldOpener,
	type PaymentHoldReleaseReason,
	type PaymentHoldRow,
	paymentHolds,
	pendingOrgSetups,
} from "@/lib/db/schema";
import type { PurchaseLease } from "@/lib/billing/purchase-lease";

/** The purchase-lease key a hold's state writes are fenced on: its payer's, `user:<payer_key>` (§4.4). */
export function payerLeaseKey(payerKey: string): string {
	return `user:${payerKey}`;
}

/** The hold a state write is prepared on: its id, and the `version` the caller read. */
export interface HoldRef {
	readonly id: string;
	readonly version: number;
}

/**
 * The lease half of a state write's fence, for use inside a statement on `payment_holds`: the caller's
 * lease is live, still names the caller as holder, AND is the hold's own payer's lease. The last clause
 * means a request holding user A's lease can never write user B's hold.
 */
function leaseFence(lease: PurchaseLease): SQL {
	return sql`EXISTS (SELECT 1 FROM purchase_leases pl
		WHERE pl.key = ${lease.key}
		  AND pl.holder = ${lease.holder}
		  AND pl.expires_at > now()
		  AND pl.key = 'user:' || ${paymentHolds.payer_key})`;
}

/** The full state-write predicate (§4.1): this row, at the version read, behind a live lease of its payer. */
function stateWriteFence(lease: PurchaseLease, ref: HoldRef): SQL | undefined {
	return and(eq(paymentHolds.id, ref.id), eq(paymentHolds.version, ref.version), leaseFence(lease));
}

/** What E0 writes (§3.2, §4.1). */
export interface OpenHoldInput {
	subscriptionId: string;
	customerId: string;
	payerKey: string;
	/** The held invoice: the subscription's `latest_invoice` at this moment (I2). */
	invoiceId: string;
	paymentIntentId?: string | null;
	/** `closing` for the purchase's write-ahead; `needs_operator` for the link's refusal (rev 5.1). */
	state: Extract<OpenPaymentHoldState, "closing" | "needs_operator">;
	nextCheckAt: Date;
	openedBy: PaymentHoldOpener;
	openedByUserId?: string | null;
	openNote?: string | null;
}

/**
 * What an open did: wrote the row; found an OPEN hold on the same subscription already (T0h — `hold` is
 * that row, or null when it was released between the conflict and the read); or wrote nothing because
 * the caller's lease is no longer live (the purchase must then void and cancel nothing, T0f).
 *
 * WARNING — `already_open.hold` may belong to ANOTHER payer: it is whatever open row holds the
 * subscription, read without a payer filter. Callers must not show it, or anything from it, to the user.
 */
export type OpenHoldResult =
	| { kind: "opened"; hold: PaymentHoldRow }
	| { kind: "already_open"; hold: PaymentHoldRow | null }
	| { kind: "lease_lost" };

/**
 * E0 (T0 / T0h): opens a hold under the payer's lease, before anything is voided or cancelled (I4).
 *
 * An INSERT cannot carry the lease predicate in its own statement the way an UPDATE does, so the fence is
 * a `FOR SHARE` read of the lease row in the same transaction: while it is held, a takeover of that
 * lease (an UPDATE of the row) waits for this commit, so the lease cannot change hands between the check
 * and the insert. A conflict on the open-row unique index (I6) writes nothing and returns the open row.
 */
export async function openHold(lease: PurchaseLease, input: OpenHoldInput): Promise<OpenHoldResult> {
	if (lease.key !== payerLeaseKey(input.payerKey)) {
		throw new Error(`openHold: a hold of ${input.payerKey} needs that payer's lease, not ${lease.key}.`);
	}
	return getServiceDb().transaction(async (tx) => {
		const live = await tx.execute(sql`SELECT 1 AS live FROM purchase_leases
			WHERE key = ${lease.key} AND holder = ${lease.holder} AND expires_at > now()
			FOR SHARE`);
		if (live.length === 0) return { kind: "lease_lost" };

		const [opened] = await tx
			.insert(paymentHolds)
			.values({
				subscription_id: input.subscriptionId,
				customer_id: input.customerId,
				payer_key: input.payerKey,
				invoice_id: input.invoiceId,
				payment_intent_id: input.paymentIntentId ?? null,
				state: input.state,
				next_check_at: input.nextCheckAt,
				opened_by: input.openedBy,
				opened_by_user_id: input.openedByUserId ?? null,
				open_note: input.openNote ?? null,
			})
			.onConflictDoNothing({ target: paymentHolds.subscription_id, where: sql`state <> 'released'` })
			.returning();
		if (opened) return { kind: "opened", hold: opened };

		const [existing] = await tx
			.select()
			.from(paymentHolds)
			.where(and(eq(paymentHolds.subscription_id, input.subscriptionId), ne(paymentHolds.state, "released")));
		return { kind: "already_open", hold: existing ?? null };
	});
}

/**
 * The columns a state write that keeps the hold open may change (§4.1 table). `state`, when given and
 * different from the current one, also stamps `state_since`. A release goes through `releaseHold`
 * instead, so that no writer can release a hold without deciding its setup.
 */
export interface HoldStatePatch {
	state?: OpenPaymentHoldState;
	attempts?: number;
	lastError?: string | null;
	lastPay?: string | null;
	refundActionSince?: Date | null;
	observedAt?: Date;
	/** Every open hold is scheduled (I10): there is no way to clear it here. */
	nextCheckAt?: Date;
	alertedAt?: Date | null;
	ageAlertedAt?: Date | null;
}

/**
 * A state write that keeps the hold open (§4.1): fenced on `version` and on the payer's live lease in one
 * statement, and bumps `version`. Returns the new row, or null when nothing was written — the hold moved
 * on since `ref` was read (C65), it is released, or the caller's lease is lost (C25).
 */
export async function writeHoldState(
	lease: PurchaseLease,
	ref: HoldRef,
	patch: HoldStatePatch,
): Promise<PaymentHoldRow | null> {
	const [row] = await getServiceDb()
		.update(paymentHolds)
		.set({
			...(patch.state !== undefined
				? {
						state: patch.state,
						state_since: sql`CASE WHEN ${paymentHolds.state} = ${patch.state} THEN ${paymentHolds.state_since} ELSE now() END`,
					}
				: {}),
			...(patch.attempts !== undefined ? { attempts: patch.attempts } : {}),
			...(patch.lastError !== undefined ? { last_error: patch.lastError } : {}),
			...(patch.lastPay !== undefined ? { last_pay: patch.lastPay } : {}),
			...(patch.refundActionSince !== undefined ? { refund_action_since: patch.refundActionSince } : {}),
			...(patch.observedAt !== undefined ? { observed_at: patch.observedAt } : {}),
			...(patch.nextCheckAt !== undefined ? { next_check_at: patch.nextCheckAt } : {}),
			...(patch.alertedAt !== undefined ? { alerted_at: patch.alertedAt } : {}),
			...(patch.ageAlertedAt !== undefined ? { age_alerted_at: patch.ageAlertedAt } : {}),
			version: sql`${paymentHolds.version} + 1`,
			updated_at: sql`now()`,
		})
		.where(and(stateWriteFence(lease, ref), ne(paymentHolds.state, "released")))
		.returning();
	return row ?? null;
}

/**
 * T5's reservation (§3.5): a state write that consumes one refund attempt number BEFORE the refund is
 * made, so a crash after it wastes a number and never reuses an idempotency key. Returns the number
 * consumed (the first is 0) with the new row, or null when nothing was written; no refund may be created
 * then.
 */
export async function reserveRefundAttempt(
	lease: PurchaseLease,
	ref: HoldRef,
): Promise<{ attempt: number; hold: PaymentHoldRow } | null> {
	const [row] = await getServiceDb()
		.update(paymentHolds)
		.set({
			refund_attempt: sql`${paymentHolds.refund_attempt} + 1`,
			version: sql`${paymentHolds.version} + 1`,
			updated_at: sql`now()`,
		})
		.where(and(stateWriteFence(lease, ref), ne(paymentHolds.state, "released")))
		.returning();
	return row ? { attempt: row.refund_attempt - 1, hold: row } : null;
}

/** What a release records (§3.1): why, who (null for the system), and an operator's note. */
export interface ReleaseHoldInput {
	reason: PaymentHoldReleaseReason;
	releasedBy?: string | null;
	note?: string | null;
	/** When the observation behind this release started; an operator release has none. */
	observedAt?: Date;
	lastPay?: string | null;
}

/**
 * Releases a hold (the state write into `released`) and, in the SAME transaction, decides its setup
 * (§4.1 "A release decides the setup", I16 (b)): for every reason but `adopted`, the still-open
 * `pending_org_setups` row with the hold's subscription is closed with `closed_reason = 'hold_released'`.
 * An `adopted` release leaves the setup as it is.
 *
 * Returns the released row and whether this call closed a setup, or null when nothing was written (the
 * version moved, the hold is already released, or the lease is lost) — and then no setup is touched.
 */
export async function releaseHold(
	lease: PurchaseLease,
	ref: HoldRef,
	input: ReleaseHoldInput,
): Promise<{ hold: PaymentHoldRow; closedSetupId: string | null } | null> {
	return getServiceDb().transaction(async (tx) => {
		const [hold] = await tx
			.update(paymentHolds)
			.set({
				state: "released",
				state_since: sql`now()`,
				release_reason: input.reason,
				released_at: sql`now()`,
				released_by: input.releasedBy ?? null,
				release_note: input.note ?? null,
				next_check_at: null,
				...(input.observedAt !== undefined ? { observed_at: input.observedAt } : {}),
				...(input.lastPay !== undefined ? { last_pay: input.lastPay } : {}),
				version: sql`${paymentHolds.version} + 1`,
				updated_at: sql`now()`,
			})
			.where(and(stateWriteFence(lease, ref), ne(paymentHolds.state, "released")))
			.returning();
		if (!hold) return null;
		if (input.reason === "adopted") return { hold, closedSetupId: null };

		// "Still open" is the setup's own definition (lib/db/schema/pending-org-setups.ts): neither linked
		// nor closed. A linked setup is finished and is not reopened or re-closed here.
		const [closed] = await tx
			.update(pendingOrgSetups)
			.set({ closed_at: sql`now()`, closed_reason: "hold_released", updated_at: sql`now()` })
			.where(
				and(
					eq(pendingOrgSetups.subscription_id, hold.subscription_id),
					isNull(pendingOrgSetups.closed_at),
					isNull(pendingOrgSetups.linked_at),
				),
			)
			.returning({ id: pendingOrgSetups.id });
		return { hold, closedSetupId: closed?.id ?? null };
	});
}

/**
 * The hint write (§4.1, §5.3): the webhook's nudge on every open hold of `subscriptionId`. It changes
 * `nudged_at` and `updated_at` and nothing else — no state, counter, schedule or `version` — so it needs
 * no fence and can never make a state write miss (C74). A nudge that lands during a step is later than
 * that step's `observed_at`, so the hold is due again at once. Returns how many holds it nudged.
 */
export async function nudgeHold(subscriptionId: string): Promise<number> {
	const rows = await getServiceDb()
		.update(paymentHolds)
		.set({ nudged_at: sql`now()`, updated_at: sql`now()` })
		.where(and(eq(paymentHolds.subscription_id, subscriptionId), ne(paymentHolds.state, "released")))
		.returning({ id: paymentHolds.id });
	return rows.length;
}

/**
 * The notice claim (§4.1, rev 7, Q3), made before a customer email is sent: `notified_state = state`
 * unless it already is. True only for the call whose claim wrote the row; only that call may send the
 * email. Touches `notified_state` and `notified_at` and nothing else.
 */
export async function claimHoldNotice(holdId: string, state: PaymentHoldNotifiedState): Promise<boolean> {
	const rows = await getServiceDb()
		.update(paymentHolds)
		.set({ notified_state: state, notified_at: sql`now()` })
		.where(and(eq(paymentHolds.id, holdId), sql`${paymentHolds.notified_state} IS DISTINCT FROM ${state}`))
		.returning({ id: paymentHolds.id });
	return rows.length > 0;
}

/**
 * Gives a notice claim back after its send threw, so the next tick retries it: clears the claim only
 * while it is still `state` (a later claim of another state is left alone).
 */
export async function unclaimHoldNotice(holdId: string, state: PaymentHoldNotifiedState): Promise<void> {
	await getServiceDb()
		.update(paymentHolds)
		.set({ notified_state: null, notified_at: null })
		.where(and(eq(paymentHolds.id, holdId), eq(paymentHolds.notified_state, state)));
}
