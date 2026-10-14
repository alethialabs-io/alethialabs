// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The payment-hold store (ADR 0002 §4.1, S4, #5755; ADR 0004 D1): the only module that writes
// `payment_holds`.
//
// SCOPE (ADR 0004 D1). Every hold belongs to one flow, `new_org` or `org_plan`, written at open and never
// changed. Its state writes are fenced on the lease `leaseKeyFor(scope, payer_key)` (lib/db/schema), so
// a request holding `user:U` can never write an `org_plan` hold, and one holding `org-plan:O` can never
// write a `new_org` hold. `openHold` takes the scope as an optional input, `new_org` when absent: every
// opener today is create-a-team and passes none. The two readers here are the org-plan flow's
// (`paymentHoldsOf`, by scope and payer) and the scope-free lookup by subscription (`openHoldOn`); the
// create-a-team readers live in lib/billing/pending-org-setup.ts and read `new_org` only.
//
// CALLERS. Outside the tests, this module's functions are imported only here:
//   - app/server/actions/billing.ts: `openHold` — E0 in the create-a-team purchase (`closeUnderHold`,
//     `opened_by = purchase`), before anything is voided or cancelled.
//   - sweeper.ts: `writeAdoptedRelinkState`, which records each relink of an adopted hold's setup
//     (`relinkAdoptedHold`: the visit, the create-a-team purchase and the sweeper's relink pass);
//     `openHold` — the link's refusal in `linkSetupToOrg` (`opened_by = link`), the core the
//     session's link in billing.ts also runs; and the three state writes
//     `writeHoldState`, `reserveRefundAttempt` and `releaseHold`, which `machineDepsFor` binds to a lease
//     and hands to `advanceHold` and `operatorRelease`. The purchase, the link and the operator command
//     build their machine deps through `machineDepsFor` too. `writeHoldState` is also called directly,
//     for the age alert's `age_alerted_at` stamp and the link refusal's `alerted_at` stamp.
//   - webhook-handler.ts (lib/billing): `nudgeHold`.
//   - app/server/actions/billing.ts: `stampHoldNotice` after a response carries a hold's clause, and
//     `holdClockNow` for the refund notice window of the holds a create-a-team purchase saw.
//   - emails.ts: `claimHoldNotice` and `unclaimHoldNotice`, around each notice send.
//   - scripts/payment-holds.ts (the operator command): `openHold` (the §8 backfill,
//     `opened_by = backfill`) and `writeHoldState` (the backfill's `alerted_at` stamp).
// machine.ts imports only this module's types. `paymentHoldsOf` and `openHoldOn` have no caller outside
// the tests yet: the org-plan purchase (ADR 0004 O6) is their first.
//
// THREE KINDS OF WRITE (§4.1), each with its own fence:
//
//   STATE WRITE   `openHold` (E0), `writeHoldState` (every transition that keeps the hold open, a failed
//                 observation's bookkeeping, the age alert), `reserveRefundAttempt` (T5's reservation,
//                 §3.5) and `releaseHold` (every release, including T16). A compare-and-set on `version`
//                 AND on the hold's own purchase lease, `leaseKeyFor(scope, payer_key)` (S2; ADR 0004
//                 D1 rule 1), in the same statement, `version = version + 1`.
//                 A request whose lease another request took over writes nothing: its statement matches
//                 no row (S2's C25, the hold-write half). A write prepared on a version another write has
//                 since bumped writes nothing either (C65).
//   HINT WRITE    `nudgeHold`: `nudged_at` and `updated_at` only. No version, no bump, no lease.
//                 `stampHoldNotice`: `notice_last_sent_at` only, when a response carried the hold's §5.5
//                 clause. No version, no bump, no lease, and no state predicate: a released hold's
//                 refund clause is carried too.
//   NOTICE CLAIM  `claimHoldNotice` / `unclaimHoldNotice`: `notified_state` and `notified_at` only. No
//                 version, no bump, no lease; its own compare-and-set makes each email at most once per
//                 hold and state.
//   RELINK WRITE  `writeAdoptedRelinkState` (amendment 2026-10-14, #6078): the one write on a RELEASED
//                 row, and only on a `new_org` hold released `adopted`. `attempts`, `last_error`,
//                 `next_check_at` and `alerted_at` only — the relink retry's count, last failure, next
//                 retry and its one give-up alert. Fenced like a state write (`version` and the payer's
//                 lease, one statement) and bumps `version`; never changes `state` or `release_*`.
// Neither a hint nor a claim touches `version`, so neither can make a state write miss (C74).
//
// THE NOTICE WINDOW'S CLOCK. `released_at` is stamped by the database's `now()`, so the 14-day refund
// notice window (§5.5) is measured on that clock too: the readers compare against `now()` in SQL, and
// `holdClockNow` gives a caller the same clock to compare a row it already holds.
//
// A RELEASE DECIDES THE SETUP (§4.1, I16 (b)). The state write that releases a `new_org` hold, for any
// reason but `adopted`, closes the `pending_org_setups` row with the hold's `subscription_id` in the SAME
// transaction (`closed_reason = 'hold_released'`), when that row is still open. An `org_plan` release
// touches no setup (ADR 0004 D1 rule 4). An `adopted` release
// leaves it open (§5.6 "When a hold ends"). The session's link, when its own advance adopts the
// subscription, goes on to link that setup itself (`linkSetupToOrg`). `relinkAdoptedSetup` (sweeper.ts)
// re-links a setup whose team exists under the caller's lease, and leaves one with no team open for the
// resume; the sweeper's visit, the create-a-team purchase (`relinkIfAdopted`) and `payment-holds release`
// call it. Since #6078 the `adopted` release of a `new_org` hold also sets `next_check_at = now()` and
// restarts `attempts` and `last_error`: that schedules the relink check the sweeper's pass retries until
// the relink is recorded as decided (`writeAdoptedRelinkState`). Every other release clears
// `next_check_at`.
//
// THE MOVED RELEASE'S ROW CHECK (§5.8 step 9). `releaseHold` with `expectOrgRow` — passed only by
// `payment-holds release --moved-to`, through `operatorRelease` — reads the team's `organization_billing`
// row `FOR SHARE` in its own transaction before the hold's update, and writes nothing unless that row
// names the subscription.
//
// Every write runs through getServiceDb(): the table is service-role only (programmables.sql).

import "server-only";
import { and, asc, eq, gt, inArray, isNull, ne, or, type SQL, sql } from "drizzle-orm";
import { REFUND_NOTICE_WINDOW_MS } from "@/lib/billing/new-org-hold-copy";
import { getServiceDb } from "@/lib/db";
import { dbNow } from "@/lib/db/now";
import {
	leaseKeyFor,
	leaseKeySql,
	type OpenPaymentHoldState,
	type PaymentHoldNotifiedState,
	type PaymentHoldOpener,
	type PaymentHoldReleaseReason,
	organizationBilling,
	type PaymentHoldRow,
	type PaymentHoldScope,
	paymentHolds,
	pendingOrgSetups,
} from "@/lib/db/schema";
import type { PurchaseLease } from "@/lib/billing/purchase-lease";

/** The hold a state write is prepared on: its id, and the `version` the caller read. */
export interface HoldRef {
	readonly id: string;
	readonly version: number;
}

/**
 * The lease half of a state write's fence, for use inside a statement on `payment_holds`: the caller's
 * lease is live, still names the caller as holder, AND is the hold's own lease,
 * `leaseKeyFor(scope, payer_key)`, computed from the row in the same statement (ADR 0004 D1 rule 1). So
 * a request holding user A's lease can never write user B's hold, and a lease of one scope can never
 * write a hold of the other, even when the two payer keys are the same string.
 */
function leaseFence(lease: PurchaseLease): SQL {
	return sql`EXISTS (SELECT 1 FROM purchase_leases pl
		WHERE pl.key = ${lease.key}
		  AND pl.holder = ${lease.holder}
		  AND pl.expires_at > now()
		  AND pl.key = ${leaseKeySql()})`;
}

/** The full state-write predicate (§4.1): this row, at the version read, behind a live lease of its own. */
function stateWriteFence(lease: PurchaseLease, ref: HoldRef): SQL | undefined {
	return and(eq(paymentHolds.id, ref.id), eq(paymentHolds.version, ref.version), leaseFence(lease));
}

/** What E0 writes (§3.2, §4.1). */
export interface OpenHoldInput {
	/** The flow the hold belongs to (ADR 0004 D1). `new_org` when absent; ADR 0004 O8 makes it required. */
	scope?: PaymentHoldScope;
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
 * WARNING — `already_open.hold` may belong to ANOTHER payer, or to another scope: it is whatever open
 * row holds the subscription, read without a payer or scope filter. Callers must not show it, or
 * anything from it, to the user.
 */
export type OpenHoldResult =
	| { kind: "opened"; hold: PaymentHoldRow }
	| { kind: "already_open"; hold: PaymentHoldRow | null }
	| { kind: "lease_lost" };

/**
 * E0 (T0 / T0h): opens a hold under its own lease, `leaseKeyFor(scope, payerKey)`, before anything is
 * voided or cancelled (I4). A lease of any other key is refused with a throw, before anything is read or
 * written (ADR 0004 D1 rule 2).
 *
 * An INSERT cannot carry the lease predicate in its own statement the way an UPDATE does, so the fence is
 * a `FOR SHARE` read of the lease row in the same transaction: while it is held, a takeover of that
 * lease (an UPDATE of the row) waits for this commit, so the lease cannot change hands between the check
 * and the insert. A conflict on the open-row unique index (I6) writes nothing and returns the open row.
 */
export async function openHold(lease: PurchaseLease, input: OpenHoldInput): Promise<OpenHoldResult> {
	const scope = input.scope ?? "new_org";
	if (lease.key !== leaseKeyFor(scope, input.payerKey)) {
		throw new Error(`openHold: a ${scope} hold of ${input.payerKey} needs that payer's lease, not ${lease.key}.`);
	}
	return getServiceDb().transaction(async (tx) => {
		const live = await tx.execute(sql`SELECT 1 AS live FROM purchase_leases
			WHERE key = ${lease.key} AND holder = ${lease.holder} AND expires_at > now()
			FOR SHARE`);
		if (live.length === 0) return { kind: "lease_lost" };

		const [opened] = await tx
			.insert(paymentHolds)
			.values({
				scope,
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
 * What the relink bookkeeping (§4.1 amendment 2026-10-14, #6078) may change on a released `adopted`
 * hold: the retry count, the last failure, the next retry (null: no more retries), and the one alert.
 */
export interface AdoptedRelinkPatch {
	attempts?: number;
	lastError?: string | null;
	nextCheckAt: Date | null;
	alertedAt?: Date;
}

/**
 * The relink bookkeeping write (§4.1 amendment 2026-10-14, #6078): the ONE write on a released row. It
 * matches only a `new_org` hold released `adopted`, at the `version` the caller read, behind the payer's
 * live lease, in one statement, and bumps `version`, so two callers can never both record one retry or
 * both raise the give-up alert. It changes `attempts`, `last_error`, `next_check_at` and `alerted_at`
 * and nothing else: never `state` or a `release_*` column. Returns the new row, or null when nothing was
 * written (the version moved, the hold is not a released `adopted` `new_org` hold, or the lease is lost).
 */
export async function writeAdoptedRelinkState(
	lease: PurchaseLease,
	ref: HoldRef,
	patch: AdoptedRelinkPatch,
): Promise<PaymentHoldRow | null> {
	const [row] = await getServiceDb()
		.update(paymentHolds)
		.set({
			...(patch.attempts !== undefined ? { attempts: patch.attempts } : {}),
			...(patch.lastError !== undefined ? { last_error: patch.lastError } : {}),
			next_check_at: patch.nextCheckAt,
			...(patch.alertedAt !== undefined ? { alerted_at: patch.alertedAt } : {}),
			version: sql`${paymentHolds.version} + 1`,
			updated_at: sql`now()`,
		})
		.where(
			and(
				stateWriteFence(lease, ref),
				eq(paymentHolds.state, "released"),
				eq(paymentHolds.release_reason, "adopted"),
				eq(paymentHolds.scope, "new_org"),
			),
		)
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
	/**
	 * The moved release only (ADR 0002 §5.8 step 9): the team's billing row must still name this
	 * subscription when the release commits. No other caller passes it.
	 */
	expectOrgRow?: { orgId: string; subscriptionId: string };
}

/** The team's billing row as a release's `expectOrgRow` check read it: its subscription and status. */
export interface CheckedOrgRow {
	subscriptionId: string | null;
	status: string;
}

/** What a release wrote: the released row, the setup it closed (or null), and the row its check read. */
export interface ReleasedHold {
	hold: PaymentHoldRow;
	closedSetupId: string | null;
	/** Set only when the release was given `expectOrgRow`. */
	checkedOrgRow?: CheckedOrgRow;
}

/**
 * Releases a hold (the state write into `released`) and, in the SAME transaction, decides its setup
 * (§4.1 "A release decides the setup", I16 (b)): for a `new_org` hold released for any reason but
 * `adopted`, the still-open `pending_org_setups` row with the hold's subscription is closed with
 * `closed_reason = 'hold_released'`. An `adopted` release, and any `org_plan` release (ADR 0004 D1
 * rule 4), leaves the setup as it is.
 *
 * With `expectOrgRow` (§5.8 step 9), the transaction first reads the team's `organization_billing` row
 * `FOR SHARE`, before the hold's update. When that row does not name the expected subscription (or there
 * is no row), nothing is written and the result is null. While the lock is held, an `UPDATE` of that row
 * (a webhook sync) waits for this commit, so the row cannot change between the check and the commit.
 * Without `expectOrgRow` no such read is made.
 *
 * Returns the released row and whether this call closed a setup, or null when nothing was written (the
 * version moved, the hold is already released, the lease is lost, or the team's row no longer names the
 * subscription) — and then no setup is touched.
 */
export async function releaseHold(
	lease: PurchaseLease,
	ref: HoldRef,
	input: ReleaseHoldInput,
): Promise<ReleasedHold | null> {
	return getServiceDb().transaction(async (tx) => {
		let checkedOrgRow: CheckedOrgRow | undefined;
		if (input.expectOrgRow) {
			const [row] = await tx
				.select({ subscriptionId: organizationBilling.stripeSubscriptionId, status: organizationBilling.status })
				.from(organizationBilling)
				.where(eq(organizationBilling.organizationId, input.expectOrgRow.orgId))
				.for("share");
			if (!row || row.subscriptionId !== input.expectOrgRow.subscriptionId) return null;
			checkedOrgRow = { subscriptionId: row.subscriptionId, status: row.status };
		}
		const [hold] = await tx
			.update(paymentHolds)
			.set({
				state: "released",
				state_since: sql`now()`,
				release_reason: input.reason,
				released_at: sql`now()`,
				released_by: input.releasedBy ?? null,
				release_note: input.note ?? null,
				// An `adopted` `new_org` release schedules its relink check at once and starts the retry count
				// afresh (§4.1 amendment 2026-10-14, #6078): the caller's own relink usually settles it first,
				// and one that never ran, or failed with nothing recorded, is picked up by the sweeper's pass.
				// Every other release is unscheduled.
				...(input.reason === "adopted"
					? {
							next_check_at: sql`CASE WHEN ${paymentHolds.scope} = 'new_org' THEN now() ELSE NULL END`,
							attempts: sql`CASE WHEN ${paymentHolds.scope} = 'new_org' THEN 0 ELSE ${paymentHolds.attempts} END`,
							last_error: sql`CASE WHEN ${paymentHolds.scope} = 'new_org' THEN NULL ELSE ${paymentHolds.last_error} END`,
						}
					: { next_check_at: null }),
				...(input.observedAt !== undefined ? { observed_at: input.observedAt } : {}),
				...(input.lastPay !== undefined ? { last_pay: input.lastPay } : {}),
				version: sql`${paymentHolds.version} + 1`,
				updated_at: sql`now()`,
			})
			.where(and(stateWriteFence(lease, ref), ne(paymentHolds.state, "released")))
			.returning();
		if (!hold) return null;
		if (input.reason === "adopted" || hold.scope !== "new_org") {
			return { hold, closedSetupId: null, ...(checkedOrgRow ? { checkedOrgRow } : {}) };
		}

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
		return { hold, closedSetupId: closed?.id ?? null, ...(checkedOrgRow ? { checkedOrgRow } : {}) };
	});
}

/**
 * The holds of `payerKey` in `scope` that a purchase in that scope reads (ADR 0002 §3.2 E1 (a), §5.5;
 * ADR 0004 D1 rule 3, D2 (a)): every OPEN one, and every one released `refunded` or `already_refunded`
 * within the refund notice window, for its clause. Keyed by the pair: `payer_key` alone is never a key,
 * so an org id and a user id that happen to be the same string never read each other's holds. The window
 * is measured on the database's clock, the one that stamped `released_at`. The org-plan purchase reads
 * `paymentHoldsOf('org_plan', orgId)` (ADR 0004 O6).
 */
export async function paymentHoldsOf(scope: PaymentHoldScope, payerKey: string): Promise<PaymentHoldRow[]> {
	const since = sql`now() - ${`${REFUND_NOTICE_WINDOW_MS} milliseconds`}::interval`;
	return getServiceDb()
		.select()
		.from(paymentHolds)
		.where(
			and(
				eq(paymentHolds.scope, scope),
				eq(paymentHolds.payer_key, payerKey),
				or(
					ne(paymentHolds.state, "released"),
					and(
						inArray(paymentHolds.release_reason, ["refunded", "already_refunded"]),
						gt(paymentHolds.released_at, since),
					),
				),
			),
		)
		.orderBy(asc(paymentHolds.created_at));
}

/**
 * The OPEN hold on `subscriptionId`, of ANY scope, or null (I6: at most one open hold per subscription,
 * across scopes). The org-plan sweep's cross-scope check (ADR 0004 D2 (b) 4): a subscription another
 * scope's hold is deciding is kept, never closed. The returned hold may be another payer's.
 */
export async function openHoldOn(subscriptionId: string): Promise<PaymentHoldRow | null> {
	const [hold] = await getServiceDb()
		.select()
		.from(paymentHolds)
		.where(and(eq(paymentHolds.subscription_id, subscriptionId), ne(paymentHolds.state, "released")))
		.limit(1);
	return hold ?? null;
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
 * The hint write of a carried clause (§4.1, §5.5): `notice_last_sent_at = now()` on each of `holdIds`,
 * the holds whose clause a response is returning. It means "returned", never "delivered". It changes
 * that column and nothing else — no state, counter, schedule, `version` or `updated_at` — so it needs no
 * lease and can never make a state write miss (C74). Returns how many holds it stamped.
 */
export async function stampHoldNotice(holdIds: readonly string[]): Promise<number> {
	if (holdIds.length === 0) return 0;
	const rows = await getServiceDb()
		.update(paymentHolds)
		.set({ notice_last_sent_at: sql`now()` })
		.where(inArray(paymentHolds.id, [...holdIds]))
		.returning({ id: paymentHolds.id });
	return rows.length;
}

/** The database's clock now: the one `released_at` is stamped by, for the refund notice window (§5.5). */
export async function holdClockNow(): Promise<Date> {
	return dbNow(getServiceDb());
}

/**
 * The hold state each notice is about: a claim of it matches only a hold that is in that state NOW.
 * `released:refunded` and `released:adopted` are terminal; `refund_pending` is not (a failed refund
 * takes the hold back to `refund_due`, T10f).
 */
function noticeStatePredicate(state: PaymentHoldNotifiedState): SQL | undefined {
	if (state === "refund_pending") return eq(paymentHolds.state, "refund_pending");
	return and(
		eq(paymentHolds.state, "released"),
		eq(paymentHolds.release_reason, state === "released:refunded" ? "refunded" : "adopted"),
	);
}

/**
 * The notice claim (§4.1, rev 7, Q3), made before a customer email is sent: `notified_state = state`
 * unless it already is, AND only while the hold is in the state the email is about, in the same
 * statement (S6's tightening of §4.1's literal predicate). So a refund that failed between the
 * sweeper's selection and this claim never gets "your refund is on its way". True only for the call
 * whose claim wrote the row; only that call may send the email. Touches `notified_state` and
 * `notified_at` and nothing else.
 */
export async function claimHoldNotice(holdId: string, state: PaymentHoldNotifiedState): Promise<boolean> {
	const rows = await getServiceDb()
		.update(paymentHolds)
		.set({ notified_state: state, notified_at: sql`now()` })
		.where(
			and(
				eq(paymentHolds.id, holdId),
				sql`${paymentHolds.notified_state} IS DISTINCT FROM ${state}`,
				noticeStatePredicate(state),
			),
		)
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
