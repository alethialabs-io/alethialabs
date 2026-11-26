// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The trial-notice sweep: the two emails a LOCAL trial is owed (lib/billing/trial/local.ts — the
// provider-less 30-day Pro grant an org whose sales go through Paddle trials on).
//
//   ending   ~3 days before the trial ends (TRIAL_ENDING_LEAD_MS): "your trial ends on <date>;
//            subscribe to keep Pro, otherwise the org moves to Hobby with nothing deleted".
//   ended    once the trial has ended (within TRIAL_ENDED_WINDOW_MS of the end): "the org is on
//            Hobby now; nothing was deleted; subscribe at any time".
//
// WHY A SWEEP. A Stripe trial is a Stripe subscription, and Stripe's own events drive its emails
// (`customer.subscription.trial_will_end` three days out, `customer.subscription.deleted` at the end,
// lib/billing/webhook-handler.ts). A local trial is only a row: nothing external happens when it is
// about to end, and it lapses by a READ-TIME rule (`isManualGrantExpired`, lib/billing/plan.ts), not
// by a write. Without this sweep, a Paddle-era org found out its trial was over by hitting Hobby's
// limits. The three-day lead is Stripe's, so both kinds of trial are warned the same distance out.
//
// WHICH ROWS. Exactly `isLocalTrialRow`'s predicate, in SQL: trialing, Pro (`team`), and backed by no
// Stripe AND no Paddle subscription. A checkout completed during the trial puts a Paddle subscription
// id on the row, so a converted org is never told its trial is ending — not even by a pass that
// selected it a moment before, because the claim re-checks the predicate in the same statement.
//
// EXACTLY ONCE PER TRIAL, AND ONLY WHILE TRUE. Each email has a claim column on
// `organization_billing` (`trial_ending_notice_for`, `trial_ended_notice_for`) holding the trial END
// the email was claimed for. The claim is one compare-and-set UPDATE that writes the row's own
// `current_period_end` into the column, and only while (a) the column does not already hold it, (b)
// the row is still a local trial, (c) its end is still the one this pass read, and (d) the timing still
// holds (not yet ended for `ending`, ended for `ended`). Only the caller whose UPDATE wrote the row
// sends. Two overlapping passes — in one process, or on two instances — therefore send once.
// Keying on the end rather than a bare "sent" flag makes the claim per TRIAL: a trial that is extended
// (an operator moving `current_period_end`) or a fresh grant on a re-used row has a new end and is
// owed its own email, while a retry of the same trial is not.
//
// A send that THROWS gives the claim back (the column returns to NULL, only while it still holds this
// end), so the next pass retries. A crash between the claim and the send loses that one email: the
// sweep prefers a missing reminder to a duplicate, as the payment-hold notices do
// (lib/billing/payment-holds/emails.ts). An org with no owner address keeps its claim — there is
// nobody to retry for.
//
// ON FIRST DEPLOY. Trials already inside the three-day window are reminded once; trials that ended
// in the last seven days are told once; older lapsed trials are left alone (they have long since met
// Hobby's limits, and an email weeks late reads as an error).
//
// Booted from the reconcile loop (lib/reconcile/loop.ts) every hour on every instance. Server-only.

import { and, asc, eq, isNull, type SQL, sql } from "drizzle-orm";
import { getServiceDb } from "@/lib/db";
import { organizationBilling } from "@/lib/db/schema";
import { type LocalTrialNotice, sendLocalTrialNoticeEmail } from "@/lib/email/billing-email";
import { log } from "@/lib/observability/log";

export type { LocalTrialNotice } from "@/lib/email/billing-email";

/** How long before a local trial ends its reminder goes out — Stripe's `trial_will_end` lead. */
export const TRIAL_ENDING_LEAD_MS = 3 * 24 * 60 * 60 * 1000;

/** How long after a local trial ended its "trial ended" notice may still be sent. */
export const TRIAL_ENDED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** At most this many notices of each kind per pass; a backlog drains over passes. */
const TRIAL_NOTICE_BATCH = 100;

/** A local trial owed a notice: its org and the trial end the notice is about. */
export interface TrialNoticeCandidate {
	organizationId: string;
	trialEnd: Date;
}

/** The database side of the sweep, so a pass is testable without Postgres. */
export interface TrialNoticeStore {
	/** Local trials owed `notice` at `now` (unclaimed for their current end), soonest end first. */
	due(notice: LocalTrialNotice, now: Date, limit: number): Promise<TrialNoticeCandidate[]>;
	/** Claims `notice` for this trial (see the header); false when another pass did, or it no longer holds. */
	claim(notice: LocalTrialNotice, candidate: TrialNoticeCandidate, now: Date): Promise<boolean>;
	/** Gives a claim back after the send threw, only while the claim still names this trial's end. */
	unclaim(notice: LocalTrialNotice, candidate: TrialNoticeCandidate): Promise<void>;
}

/** Sends one notice. Resolves false when there was nobody to send it to; throws when the send failed. */
export type DeliverTrialNotice = (notice: LocalTrialNotice, candidate: TrialNoticeCandidate) => Promise<boolean>;

/** Everything a pass reads from its surroundings. */
export interface TrialNoticeSweepDeps {
	store: TrialNoticeStore;
	deliver: DeliverTrialNotice;
	log: (message: string, fields: Record<string, string | number | boolean | null>) => void;
}

/** What a pass did, for the log line, the heartbeat and tests. */
export type TrialNoticeSweepResult = {
	endingSent: number;
	endedSent: number;
	/** Claimed but not sent: the org has no owner with an address. */
	noRecipient: number;
	/** Selected but not claimed: another pass claimed it, or it stopped being a local trial. */
	claimLost: number;
	/** Send failed; the claim was given back for the next pass. */
	failed: number;
};

/** A short reason from a thrown value. */
function reasonOf(err: unknown): string {
	return (err instanceof Error ? err.message : String(err)).slice(0, 500);
}

/**
 * One pass: every owed `ending` reminder, then every owed `ended` notice, each under its claim. One
 * org's failure gives its claim back and does not stop the others; the pass throws at the end if any
 * send failed, so the reconcile heartbeat shows it.
 */
export async function runTrialNoticeSweep(
	now: Date = new Date(),
	deps: TrialNoticeSweepDeps = defaultDeps(),
): Promise<TrialNoticeSweepResult> {
	const result: TrialNoticeSweepResult = { endingSent: 0, endedSent: 0, noRecipient: 0, claimLost: 0, failed: 0 };
	const errors: string[] = [];

	for (const notice of ["ending", "ended"] as const) {
		for (const c of await deps.store.due(notice, now, TRIAL_NOTICE_BATCH)) {
			if (!(await deps.store.claim(notice, c, now))) {
				result.claimLost += 1;
				continue;
			}
			try {
				if (await deps.deliver(notice, c)) {
					if (notice === "ending") result.endingSent += 1;
					else result.endedSent += 1;
				} else {
					result.noRecipient += 1;
					deps.log("[billing] local trial notice has no recipient; not sent", {
						notice,
						organization_id: c.organizationId,
					});
				}
			} catch (err) {
				result.failed += 1;
				errors.push(`${notice} for org ${c.organizationId}: ${reasonOf(err)}`);
				try {
					await deps.store.unclaim(notice, c);
				} catch (unclaimErr) {
					errors.push(`unclaim ${notice} for org ${c.organizationId}: ${reasonOf(unclaimErr)}`);
				}
			}
		}
	}
	if (errors.length > 0) {
		throw new Error(`trial notice sweep: ${errors.length} failed — ${errors.slice(0, 5).join("; ")}`);
	}
	return result;
}

// ── Postgres store + default wiring ────────────────────────────────────────────────────────────

/** The claim column of each notice. */
function claimColumn(notice: LocalTrialNotice) {
	return notice === "ending" ? organizationBilling.trialEndingNoticeFor : organizationBilling.trialEndedNoticeFor;
}

/** `isLocalTrialRow` (lib/billing/trial/local.ts) as SQL: trialing Pro, no provider subscription. */
function localTrialPredicate(): SQL | undefined {
	const ob = organizationBilling;
	return and(
		eq(ob.status, "trialing"),
		eq(ob.plan, "team"),
		isNull(ob.stripeSubscriptionId),
		isNull(ob.paddleSubscriptionId),
	);
}

/** Whether the row's trial end puts it in `notice`'s window at `now`. */
function windowPredicate(notice: LocalTrialNotice, now: Date): SQL {
	const end = organizationBilling.currentPeriodEnd;
	const at = now.toISOString();
	if (notice === "ending") {
		const horizon = new Date(now.getTime() + TRIAL_ENDING_LEAD_MS).toISOString();
		return sql`${end} > ${at}::timestamptz and ${end} <= ${horizon}::timestamptz`;
	}
	const floor = new Date(now.getTime() - TRIAL_ENDED_WINDOW_MS).toISOString();
	return sql`${end} <= ${at}::timestamptz and ${end} > ${floor}::timestamptz`;
}

/** The Postgres store. Service role only. */
const postgresTrialNoticeStore: TrialNoticeStore = {
	async due(notice, now, limit) {
		const ob = organizationBilling;
		const col = claimColumn(notice);
		const rows = await getServiceDb()
			.select({ organizationId: ob.organizationId, trialEnd: ob.currentPeriodEnd })
			.from(ob)
			.where(
				and(localTrialPredicate(), windowPredicate(notice, now), sql`${col} is distinct from ${ob.currentPeriodEnd}`),
			)
			.orderBy(asc(ob.currentPeriodEnd))
			.limit(limit);
		const out: TrialNoticeCandidate[] = [];
		for (const r of rows) {
			if (r.trialEnd) out.push({ organizationId: r.organizationId, trialEnd: r.trialEnd });
		}
		return out;
	},

	async claim(notice, candidate, now) {
		const ob = organizationBilling;
		const col = claimColumn(notice);
		// The column takes the row's OWN end, not the JS Date read back: Postgres keeps microseconds
		// and a Date keeps milliseconds, so writing the parameter could leave the column forever
		// "distinct" from an end an operator set by hand — and the email re-sent every pass. The read
		// end is matched at millisecond precision only to confirm it is still the same trial.
		const rows = await getServiceDb()
			.update(ob)
			.set(notice === "ending" ? { trialEndingNoticeFor: sql`${ob.currentPeriodEnd}` } : { trialEndedNoticeFor: sql`${ob.currentPeriodEnd}` })
			.where(
				and(
					eq(ob.organizationId, candidate.organizationId),
					localTrialPredicate(),
					windowPredicate(notice, now),
					sql`date_trunc('milliseconds', ${ob.currentPeriodEnd}) = ${candidate.trialEnd.toISOString()}::timestamptz`,
					sql`${col} is distinct from ${ob.currentPeriodEnd}`,
				),
			)
			.returning({ id: ob.id });
		return rows.length > 0;
	},

	async unclaim(notice, candidate) {
		const ob = organizationBilling;
		const col = claimColumn(notice);
		await getServiceDb()
			.update(ob)
			.set(notice === "ending" ? { trialEndingNoticeFor: null } : { trialEndedNoticeFor: null })
			.where(
				and(
					eq(ob.organizationId, candidate.organizationId),
					sql`date_trunc('milliseconds', ${col}) = ${candidate.trialEnd.toISOString()}::timestamptz`,
				),
			);
	},
};

/** The production wiring: the Postgres store and the billing-email sender. */
function defaultDeps(): TrialNoticeSweepDeps {
	return {
		store: postgresTrialNoticeStore,
		deliver: (notice, c) => sendLocalTrialNoticeEmail({ orgId: c.organizationId, notice, trialEnd: c.trialEnd }),
		log: (message, fields) => log.warn(message, fields),
	};
}
