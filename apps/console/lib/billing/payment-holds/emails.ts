// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Q3 emails of a payment hold (ADR 0002 Q3, §4.1 "Notice claim", §5.4 "Who sends the Q3 emails";
// S6 #5783; ADR 0004 D8). Three, each to the hold's payer only, and each at most once per hold and state:
//
//   refund_pending      the refund was issued and is on its way back (and, §3.1, that buying again
//                       before it lands may show both charges if it then fails);
//   released:refunded   the refund reads `succeeded` in full (`release_reason = refunded`);
//   released:adopted    the payment went through and the team can be finished from Create a team —
//                       only for a `new_org` hold, and only while the hold's setup has NO org (§5.6 "When a
//                       hold ends"). A setup with an org is re-linked from slice 9 on, and is the
//                       creator's to link until then. An `org_plan` adoption is never mailed (ADR 0004
//                       D8): there is no setup to finish, and Stripe's receipt speaks.
//
// THE RECIPIENT, PER SCOPE (`deliverHoldNotice`). A `new_org` hold's payer is a user, mailed at their own
// address (`payer_key` is the user id). An `org_plan` hold's payer is an org, mailed at the address
// Stripe receipts already go to: its Stripe customer's email (ADR 0004 D8, Q7).
//
// THE COPY, PER SCOPE. A `new_org` hold gets the create-a-team copy (`sendPaymentHoldNoticeEmail`). An
// `org_plan` hold gets the org-plan copy (`sendOrgPlanHoldNoticeEmail`), which names no team setup: the
// purchase was a plan for a team that already exists (ADR 0004 D8, O7).
//
// ONE SENDER. Only a sweeper tick calls `sendDueHoldNotices` — the in-process loop, its cron twin, and
// the operator command's `reconcile`, which runs one tick and so CAN send these emails. The command's
// `release` and the backfill move holds but never mail; neither will the purchase flow and the link when
// they move holds (slices 8 and 9). Whichever caller moved a hold, its email goes out within one tick.
//
// AT MOST ONCE, AND ONLY WHILE TRUE. Before a send, the notice claim (store.ts `claimHoldNotice`) sets
// `notified_state` with a compare-and-set that ALSO requires the hold to be in the email's state now, in
// the same statement — so a refund that failed between the selection and the claim (`refund_due`) is
// never told "your refund is on its way". Only the caller whose claim wrote the row sends. Two overlapping ticks — in one
// process, or on two instances — therefore mail a hold and state once. A send that throws gives the claim
// back (`unclaimHoldNotice`), so the next tick retries; a crash between the claim and the send loses that
// one email, and the create-a-team `notice` still carries the clause.
//
// The emails say only what was read (I8): "refunded" only for a release whose refunds read `succeeded`,
// "issued" for `refund_pending`. They carry no amount, card or invoice detail.

import "server-only";
import { and, asc, eq, gt, like, or, type SQL, sql } from "drizzle-orm";
import { newOrgSubscriptionIdOf } from "@/lib/billing/new-org-setup";
import { getStripe } from "@/lib/billing/stripe";
import { getServiceDb } from "@/lib/db";
import {
	type PaymentHoldNotifiedState,
	type PaymentHoldRow,
	type PaymentHoldScope,
	organization,
	paymentHolds,
	pendingOrgSetups,
	user,
} from "@/lib/db/schema";
import { sendOrgPlanHoldNoticeEmail, sendPaymentHoldNoticeEmail } from "@/lib/email/billing-email";
import { claimHoldNotice, unclaimHoldNotice } from "./store";

/** How long after its release a hold's email may still be sent (§5.4). */
const RELEASED_NOTICE_WINDOW_DAYS = 14;

/** The most emails one tick sends. */
const NOTICE_BATCH = 50;

/** Sends one hold's email for `notice`. Throws when the send failed, so the claim is given back. */
export type DeliverHoldNotice = (hold: PaymentHoldRow, notice: PaymentHoldNotifiedState) => Promise<void>;

/** The email a hold in its current state is owed, or null. Only a `new_org` adoption is mailed (ADR 0004 D8). */
function noticeOf(hold: PaymentHoldRow): PaymentHoldNotifiedState | null {
	if (hold.state === "refund_pending") return "refund_pending";
	if (hold.state !== "released") return null;
	if (hold.release_reason === "refunded") return "released:refunded";
	if (hold.release_reason === "adopted" && hold.scope === "new_org") return "released:adopted";
	return null;
}

/**
 * The holds owed an email now (§5.4): `refund_pending`, or released `refunded` / `adopted` within the
 * window, whose claimed state is not that one. An `adopted` hold counts only when it is `new_org`, and
 * only while an OPEN setup with no org names its subscription.
 */
function owedNotice(): SQL | undefined {
	const recent = gt(paymentHolds.released_at, sql`now() - (${RELEASED_NOTICE_WINDOW_DAYS}::int * interval '1 day')`);
	const setupWithoutOrg = sql`EXISTS (SELECT 1 FROM ${pendingOrgSetups}
		WHERE ${pendingOrgSetups.subscription_id} = ${paymentHolds.subscription_id}
		  AND ${pendingOrgSetups.created_org_id} IS NULL
		  AND ${pendingOrgSetups.linked_at} IS NULL
		  AND ${pendingOrgSetups.closed_at} IS NULL)`;
	return or(
		and(
			eq(paymentHolds.state, "refund_pending"),
			sql`${paymentHolds.notified_state} IS DISTINCT FROM 'refund_pending'`,
		),
		and(
			eq(paymentHolds.state, "released"),
			eq(paymentHolds.release_reason, "refunded"),
			recent,
			sql`${paymentHolds.notified_state} IS DISTINCT FROM 'released:refunded'`,
		),
		and(
			eq(paymentHolds.scope, "new_org"),
			eq(paymentHolds.state, "released"),
			eq(paymentHolds.release_reason, "adopted"),
			recent,
			sql`${paymentHolds.notified_state} IS DISTINCT FROM 'released:adopted'`,
			setupWithoutOrg,
		),
	);
}

/**
 * Whether an organization already carries the server-stamped marker naming `subscriptionId` — the
 * org exists even though `recordNewOrgCreated` never wrote `created_org_id` (C93). The LIKE only
 * prefilters; the parsed marker decides.
 */
async function markedOrgExists(subscriptionId: string): Promise<boolean> {
	const candidates = await getServiceDb()
		.select({ metadata: organization.metadata })
		.from(organization)
		.where(like(organization.metadata, `%${subscriptionId}%`));
	return candidates.some((o) => newOrgSubscriptionIdOf(o.metadata) === subscriptionId);
}

/**
 * Sends every Q3 email that is owed (at most `NOTICE_BATCH` a call), each under the notice claim, and
 * returns how many were sent. One email's failure gives its claim back and does not stop the others.
 */
export async function sendDueHoldNotices(input: {
	deliver: DeliverHoldNotice;
	/** Only this scope's holds (the operator's `reconcile --scope`). */
	scope?: PaymentHoldScope;
	/** Only this payer's holds (the operator's `reconcile --payer`); with `scope`, the pair. */
	payerKey?: string;
}): Promise<number> {
	const owed = await getServiceDb()
		.select()
		.from(paymentHolds)
		.where(
			and(
				owedNotice(),
				input.scope ? eq(paymentHolds.scope, input.scope) : undefined,
				input.payerKey ? eq(paymentHolds.payer_key, input.payerKey) : undefined,
			),
		)
		.orderBy(asc(paymentHolds.updated_at))
		.limit(NOTICE_BATCH);

	let sent = 0;
	for (const hold of owed) {
		const notice = noticeOf(hold);
		if (notice === null) continue;
		try {
			// An adoption whose org exists by its marker is the link's, not "finish creating your team".
			if (notice === "released:adopted" && (await markedOrgExists(hold.subscription_id))) continue;
			if (!(await claimHoldNotice(hold.id, notice))) continue;
		} catch (err) {
			console.error(`[billing] could not claim the ${notice} email of payment hold ${hold.id}:`, err);
			continue;
		}
		try {
			await input.deliver(hold, notice);
			sent += 1;
		} catch (err) {
			console.error(`[billing] the ${notice} email of payment hold ${hold.id} failed; the next tick retries:`, err);
			try {
				await unclaimHoldNotice(hold.id, notice);
			} catch (unclaimErr) {
				console.error(`[billing] could not give back the ${notice} claim of payment hold ${hold.id}:`, unclaimErr);
			}
		}
	}
	return sent;
}

/** A user id the `user` table can hold (a uuid); anything else names nobody. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The address an `org_plan` hold's email goes to (ADR 0004 D8): its Stripe customer's email, the address
 * Stripe receipts go to. Null when the customer is deleted or has no email. A failed read throws.
 */
async function orgPlanRecipient(hold: PaymentHoldRow): Promise<string | null> {
	const customer = await getStripe().customers.retrieve(hold.customer_id);
	return customer.deleted ? null : (customer.email ?? null);
}

/**
 * The live sender: the email for `notice`, in its scope's copy, to the hold's payer — a `new_org` payer
 * at the user's own address with the create-a-team copy, an `org_plan` payer at its Stripe customer's
 * email with the org-plan copy (ADR 0004 D8). A payer with no account or no address any more gets
 * nothing, and the claim stands (there is nobody to retry for). Throws when the address could not be read
 * or the send itself failed, so the claim is given back, and throws for an `org_plan` adoption, which has
 * no email (`noticeOf` never selects one).
 */
export async function deliverHoldNotice(hold: PaymentHoldRow, notice: PaymentHoldNotifiedState): Promise<void> {
	if (hold.scope === "org_plan") {
		if (notice === "released:adopted") {
			throw new Error(`payment hold ${hold.id}: an org_plan adoption is never mailed (ADR 0004 D8)`);
		}
		const to = await orgPlanRecipient(hold);
		if (!to) {
			console.warn(`[billing] payment hold ${hold.id}: its customer has no email; the ${notice} email was not sent.`);
			return;
		}
		await sendOrgPlanHoldNoticeEmail({ to, notice });
		return;
	}
	if (!UUID.test(hold.payer_key)) return;
	const [payer] = await getServiceDb()
		.select({ email: user.email })
		.from(user)
		.where(eq(user.id, hold.payer_key))
		.limit(1);
	if (!payer) {
		console.warn(`[billing] payment hold ${hold.id}: its payer has no account; the ${notice} email was not sent.`);
		return;
	}
	await sendPaymentHoldNoticeEmail({ to: payer.email, notice });
}
