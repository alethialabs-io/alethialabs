// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The payment-hold sweeper (ADR 0002 §5.4, I10, I11, Q3; S6 #5783): the REQUIRED scheduled caller of
// `advanceHold`. Liveness of every open hold rests on it, not on Stripe's webhook retries (§1.3 S10).
//
// ONE TICK (`runPaymentHoldSweep`):
//   1. selects the open holds that are DUE — `next_check_at <= now()`, or nudged since their last
//      observation (`nudged_at > observed_at`; the webhook sets `nudged_at` through `nudgeHold`) — oldest first, at most
//      `SWEEP_BATCH`;
//   2. for each, takes its payer's lease (`user:<payer>`) with a ZERO wait: a lease another caller holds
//      (the operator, another instance's tick, a create-a-team purchase) skips that hold until the
//      next tick;
//   3. under the lease, re-reads the row, runs `advanceHold` (up to 3 Stripe writes), and then the AGE
//      ALERT (§5.4, I11): once per hold and state entry, when the hold has sat in its state past the
//      bound its state and last observation give it (`ageAlertFor`);
//   4. sends the Q3 emails (`sendDueHoldNotices`, emails.ts) — the sweeper is their ONLY sender.
//
// It runs on every instance: the lease serialises them per payer, every state write is the store's
// compare-and-set on `version` and on that lease, and each email is claimed before it is sent. So two
// overlapping ticks, in one process or across instances, cannot advance one hold twice at once or mail
// one hold and state twice.
//
// WHEN A HOLD ENDS (§5.6, I16 (b)). An `adopted` release whose setup has an org runs the link's core
// at once, under the same lease (`relinkAdoptedSetup`): the visit here, the create-a-team purchase (its
// hold pass and its sweep) and `payment-holds release` all call it. The core (`linkSetupToOrg`) lives in this file because
// the sweeper is its caller with no session, and the session's link (app/server/actions/billing.ts)
// runs the same function. A setup with no org stays open for the creator's resume — and that includes a
// setup whose team was DELETED: `created_org_id` is `ON DELETE SET NULL` and the marker goes with the org
// row, so it reads as no org. A setup whose team exists but whose creator is no longer an active member
// of it is alerted on and left open. This path only READS membership: it never adds anyone to an org.
//
// Booted from instrumentation.ts every 5 minutes (`startPaymentHoldSweeper`, the `registerLoop` shape),
// with the optional twin route app/api/internal/payment-holds/sweep behind ALETHIA_CRON_SECRET, and
// `wakePaymentHoldSweeper()` for one immediate, coalesced tick.

import "server-only";
import { and, asc, eq, like, lte, ne, or, type SQL, sql } from "drizzle-orm";
import type Stripe from "stripe";
import { LEGAL_ENTITY } from "@repo/legal/entity";
import { getActiveScope } from "@/lib/auth/scope";
import { getPdp } from "@/lib/authz";
import type { PayerCapacity } from "@repo/legal/commerce";
import { alertPaymentNeedsSupport } from "@/lib/billing/payment-alert";
import { newOrgCreatedByOf, newOrgSubscriptionIdOf } from "@/lib/billing/new-org-setup";
import {
	logBillingEvent,
	markPendingOrgSetupLinked,
	type PendingOrgSetupRow,
	pendingOrgSetupFor,
	recordSetupRefusal,
} from "@/lib/billing/pending-org-setup";
import { getOrgBilling } from "@/lib/billing/queries";
import { getPurchaseStripe } from "@/lib/billing/stripe";
import { syncSubscriptionToBilling } from "@/lib/billing/sync";
import {
	fenceFor,
	type PurchaseLease,
	PurchaseLeaseLostError,
	releasePurchaseLease,
	tryAcquirePurchaseLease,
} from "@/lib/billing/purchase-lease";
import { getServiceDb } from "@/lib/db";
import { member, organization, organizationBilling, type PaymentHoldRow, paymentHolds } from "@/lib/db/schema";
import { registerLoop, superviseLoop } from "@/lib/observability/heartbeats";
import { type DeliverHoldNotice, deliverHoldNotice, sendDueHoldNotices } from "./emails";
import {
	type AdvanceResult,
	advanceHold,
	type HoldMachineDeps,
	type HoldStripeWriter,
	LINK_REFUSED_NOTE,
} from "./machine";
import type { HoldStripeReader } from "./observe";
import { openHold, payerLeaseKey, releaseHold, reserveRefundAttempt, writeHoldState } from "./store";

/** How often the in-process sweeper ticks (§5.4). */
export const SWEEP_INTERVAL_MS = 5 * 60_000;

/** The most holds one tick advances (§5.4). */
export const SWEEP_BATCH = 50;

/** Stable supervision id for this loop (lib/observability/heartbeats.ts). */
export const PAYMENT_HOLD_SWEEPER_LOOP_ID = "payment-hold-sweeper";

/** The Stripe client the machine needs: its reads and its writes. */
export type HoldStripe = HoldStripeReader & HoldStripeWriter;

/** Everything a tick touches outside the database, injectable for tests. */
export interface SweepDeps {
	/** Built only when a hold needs Stripe, so a deployment with no Stripe key never builds one. */
	stripe: () => HoldStripe;
	alert: HoldMachineDeps["alert"];
	deliver: DeliverHoldNotice;
	now: () => Date;
}

/**
 * The live dependencies. Stripe is the purchase path's client (lib/billing/stripe.ts): the machine's
 * calls run under the same 120s lease as the purchase's, so they get its shorter timeout.
 */
export function liveSweepDeps(): SweepDeps {
	return {
		stripe: () => getPurchaseStripe(),
		// Every hold alert names the hold, not the purchase flow: the backfill opens holds too.
		alert: (input) => alertPaymentNeedsSupport({ ...input, context: "payment_hold" }),
		deliver: deliverHoldNotice,
		now: () => new Date(),
	};
}

/** What one tick did, as counts only: no subscription, payer or amount leaves the sweeper. */
export interface SweepResult {
	/** Due holds selected. */
	due: number;
	/** Holds `advanceHold` ran on. */
	advanced: number;
	/** Of those, holds the call released. */
	released: number;
	/** Holds skipped because another caller held their payer's lease. */
	busy: number;
	/** Holds whose state write matched no row, or whose lease was lost mid-call. */
	stale: number;
	/** Age alerts raised. */
	ageAlerts: number;
	/** Q3 emails sent. */
	notices: number;
}

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

/** The age bound an alert is raised past (§5.4), with the clause that names it. */
interface AgeBound {
	since: Date;
	ms: number;
	what: string;
}

/**
 * The §5.4 age bound that applies to `hold` now, or null when none does: the clock it runs from, its
 * length, and what it is about. Pure.
 *
 * `refund_due` has no row of its own in §5.4 — the refund budget sends it to an operator (T14) after
 * about 8h35m of failed attempts, or 32h35m when the last attempt's refund never reads back. That bound
 * holds only while observations succeed, so a 48h backstop from the state's entry alerts when they keep
 * failing and no attempt runs at all (I11: every open state has a finite bound).
 */
function ageBoundOf(hold: PaymentHoldRow): AgeBound | null {
	const entered = hold.state_since;
	const pay = hold.last_pay;
	switch (hold.state) {
		case "closing":
		case "cancel_unproven":
			if (pay === "in_flight") return { since: entered, ms: 14 * DAY, what: "a payment still processing" };
			if (pay === "capturable") return { since: entered, ms: 8 * DAY, what: "a payment authorised, not captured" };
			if (pay === "succeeded") return { since: entered, ms: HOUR, what: "a paid subscription not yet active" };
			return { since: entered, ms: DAY, what: "a checkout not proven closed" };
		case "payment_in_flight":
			return pay === "capturable"
				? { since: entered, ms: 8 * DAY, what: "a payment authorised, not captured" }
				: { since: entered, ms: 14 * DAY, what: "a payment still processing" };
		case "invoice_payable":
			return { since: entered, ms: DAY, what: "an invoice not proven unpayable" };
		case "refund_due":
			return { since: entered, ms: 2 * DAY, what: "a refund owed and not issued" };
		case "refund_pending":
			// Two bounds in one state entry, each alerting once: `refundPendingAlert`.
			return null;
		default:
			return null;
	}
}

/**
 * Whether the sweeper raises an age alert for `hold` at `now` (§5.4, I11), and why — null when not.
 * Once per hold and state entry: a hold whose `age_alerted_at` is at or after its `state_since` was
 * already alerted for this entry. `needs_operator` alerts only when its entry alert did not reach a
 * channel (`alerted_at` before the entry): 24h after the entry, then every 7 days. Pure.
 */
export function ageAlertFor(hold: PaymentHoldRow, now: Date): string | null {
	if (hold.state === "released") return null;
	const alertedThisEntry = hold.age_alerted_at !== null && hold.age_alerted_at >= hold.state_since;
	if (hold.state === "needs_operator") {
		if (hold.alerted_at !== null && hold.alerted_at >= hold.state_since) return null;
		const since = alertedThisEntry && hold.age_alerted_at !== null ? hold.age_alerted_at : hold.state_since;
		const ms = alertedThisEntry ? 7 * DAY : DAY;
		return now.getTime() - since.getTime() >= ms
			? `payment hold ${hold.id} has waited for an operator since ${hold.state_since.toISOString()}, and its alert did not reach a channel`
			: null;
	}
	if (hold.state === "refund_pending") return refundPendingAlert(hold, now);
	if (alertedThisEntry) return null;
	const bound = ageBoundOf(hold);
	if (!bound || now.getTime() - bound.since.getTime() < bound.ms) return null;
	return `payment hold ${hold.id} has been ${hold.state} since ${hold.state_since.toISOString()} (${bound.what}; last observation ${hold.last_pay ?? "none"})`;
}

/**
 * `refund_pending`'s two §5.4 rows, each alerting once in a state entry: 24h after a covering refund
 * went `requires_action` (from `refund_action_since`), and 14 days after the entry whatever the refunds
 * read. The 14-day alert still fires after the 24h one: it is due unless an age alert was already raised
 * at or past the 14-day mark. Pure.
 */
function refundPendingAlert(hold: PaymentHoldRow, now: Date): string | null {
	const t = now.getTime();
	const last = hold.age_alerted_at?.getTime() ?? null;
	const actionSince = hold.refund_action_since;
	if (actionSince !== null) {
		const due = Math.max(actionSince.getTime(), hold.state_since.getTime()) + DAY;
		if (t >= due && (last === null || last < due)) {
			return `payment hold ${hold.id} has a refund waiting on requires_action since ${actionSince.toISOString()}`;
		}
	}
	const due = hold.state_since.getTime() + 14 * DAY;
	if (t >= due && (last === null || last < due)) {
		return `payment hold ${hold.id} has been refund_pending since ${hold.state_since.toISOString()} (a refund not yet settled; last observation ${hold.last_pay ?? "none"})`;
	}
	return null;
}

/** The machine's dependencies for one hold under `lease`: the store's writes bound to it, and its fence. */
export function machineDepsFor(lease: PurchaseLease, deps: SweepDeps): HoldMachineDeps {
	const stripe = deps.stripe();
	return {
		reader: stripe,
		writer: stripe,
		store: {
			write: (ref, patch) => writeHoldState(lease, ref, patch),
			reserveRefundAttempt: (ref) => reserveRefundAttempt(lease, ref),
			release: (ref, input) => releaseHold(lease, ref, input),
		},
		fence: fenceFor(lease),
		alert: deps.alert,
		now: deps.now,
	};
}

/** The open hold `id` as the database has it now, or null when it is released or gone. */
async function readOpenHold(id: string): Promise<PaymentHoldRow | null> {
	const [row] = await getServiceDb()
		.select()
		.from(paymentHolds)
		.where(and(eq(paymentHolds.id, id), ne(paymentHolds.state, "released")));
	return row ?? null;
}

/** What one hold's visit did. `relinked` is the re-link an `adopted` release ran, or null when none ran. */
export type HoldVisit =
	| { kind: "busy" }
	| { kind: "gone" }
	| { kind: "advanced"; result: AdvanceResult; ageAlerted: boolean; relinked: RelinkResult | null };

/**
 * Advances one open hold under ITS payer's lease, taken with a zero wait, then raises its age alert when
 * one is due. The caller passes the row it selected; it is re-read under the lease, so a hold another
 * caller moved or released in between is advanced from what the database has now. The lease is given
 * back whatever happens.
 */
export async function visitHold(hold: PaymentHoldRow, deps: SweepDeps): Promise<HoldVisit> {
	const lease = await tryAcquirePurchaseLease(payerLeaseKey(hold.payer_key));
	if (!lease) return { kind: "busy" };
	try {
		const fresh = await readOpenHold(hold.id);
		if (!fresh) return { kind: "gone" };
		const result = await advanceHold(fresh, machineDepsFor(lease, deps));
		const ageAlerted = result.outcome === "open" ? await raiseAgeAlert(lease, result.hold, deps) : false;
		const relinked = isAdopted(result.hold) ? await relinkAfterVisit(lease, result.hold, deps) : null;
		return { kind: "advanced", result, ageAlerted, relinked };
	} finally {
		try {
			await releasePurchaseLease(lease);
		} catch (err) {
			console.error("[billing] payment-hold sweeper could not release a lease; it lapses on its own:", err);
		}
	}
}

/**
 * The age alert (§5.4) for `hold`, under `lease`: stamps `age_alerted_at` with a fenced state write
 * FIRST, and raises the alert only when that write returned the row, so two callers can never both
 * alert for one entry. True when an alert was raised.
 */
async function raiseAgeAlert(lease: PurchaseLease, hold: PaymentHoldRow, deps: SweepDeps): Promise<boolean> {
	const now = deps.now();
	const detail = ageAlertFor(hold, now);
	if (detail === null) return false;
	const stamped = await writeHoldState(lease, { id: hold.id, version: hold.version }, { ageAlertedAt: now });
	if (!stamped) return false;
	await deps.alert({
		subscriptionId: hold.subscription_id,
		customerId: hold.customer_id,
		paymentIntentId: hold.payment_intent_id,
		detail,
	});
	return true;
}

// ── The link's core, and the re-link when a hold ends (§5.6) ───────────────────────────────────────

const SUPPORT_EMAIL = LEGAL_ENTITY.supportEmail;

/** §5.5: the link refused beside the team's other live, paid plan. */
export const LINK_REFUSED_ORG_HAS_PLAN = `This team already has an active plan, so this payment was not linked to it. Contact support at ${SUPPORT_EMAIL}, who will refund it or move it to the right team.`;
/** Appended to `LINK_REFUSED_ORG_HAS_PLAN` only when the alert behind it reached a channel (I8). */
export const LINK_REFUSED_ALERTED = " We have raised this with support.";

/** How long a `needs_operator` hold the link opens waits before the sweeper looks at it again (§3.1). */
const OPERATOR_CHECK_MS = 24 * 60 * 60_000;

/** Subscription statuses under which Stripe will never collect a payment for it again. */
const ENDED_STATUSES: ReadonlySet<string> = new Set(["canceled", "incomplete_expired"]);

/**
 * What the link's core did: linked X (`sub` is X as its metadata write returned it), or refused it
 * beside the org's other live plan with the sentence the customer is shown, and the `needs_operator`
 * hold that names X (null when none could be opened, or the open one is another payer's).
 */
export type SetupLinkResult =
	| { kind: "linked"; sub: Stripe.Subscription }
	| { kind: "refused"; clause: string; hold: PaymentHoldRow | null };

/**
 * The org's billing row names a subscription other than `subscriptionId` that still bills: active,
 * trialing, or past_due. `past_due` is a deliberate widening of "live" for THIS refusal only (#5715
 * review): the sync's row guard also refuses an X that does not supersede a past_due Y, so without it
 * the link would mark X linked while X and Y both bill. Refusing here sends both to a person instead.
 */
function namesOtherLivePlan(billing: Awaited<ReturnType<typeof getOrgBilling>>, subscriptionId: string): boolean {
	return (
		!!billing?.stripeSubscriptionId &&
		billing.stripeSubscriptionId !== subscriptionId &&
		(billing.status === "active" || billing.status === "trialing" || billing.status === "past_due")
	);
}

/** The id of a subscription's latest invoice, expanded or not; null when it has none. */
function latestInvoiceOf(sub: Pick<Stripe.Subscription, "latest_invoice">): string | null {
	return typeof sub.latest_invoice === "string" ? sub.latest_invoice : (sub.latest_invoice?.id ?? null);
}

/** A hold's alert reached a channel in its CURRENT state entry (I8; `ageAlertFor`'s rule). */
function alertedThisEntry(hold: PaymentHoldRow): boolean {
	return hold.alerted_at !== null && hold.alerted_at >= hold.state_since;
}

/**
 * THE LINK'S CORE (ADR 0002 §5.6), run under `userId`'s purchase lease by the session's link and by
 * `relinkSetup`. It reads no session: its callers have already checked that X's customer was minted by
 * `userId`, that X names no org but `orgId`, and that `userId` may manage billing in `orgId`.
 *
 * Beside another live plan on the org's row, read BEFORE any Stripe write, it refuses
 * (`refuseBesideLivePlan`). Otherwise it writes `organization_id` on the customer, then on X — each
 * Stripe write renews the lease first — unless X already names `orgId`, then syncs X to the org's row.
 * A sync the row's guard ignored while the row, read again, names another live plan is the same refusal:
 * Y took the row in between, and X's metadata already names the org. Then the payer facts, when given,
 * and last the setup's mark, so the mark says only what has fully happened.
 */
export async function linkSetupToOrg(input: {
	userId: string;
	orgId: string;
	sub: Stripe.Subscription;
	customerId: string;
	lease: PurchaseLease;
	payer?: { capacity: PayerCapacity | null; billingCountry: string | null };
}): Promise<SetupLinkResult> {
	const { userId, orgId, sub, customerId, lease } = input;
	const fence = fenceFor(lease);
	const before = await getOrgBilling(orgId);
	if (namesOtherLivePlan(before, sub.id)) {
		return refuseBesideLivePlan({ userId, orgId, sub, customerId, lease, rowSubscriptionId: before?.stripeSubscriptionId ?? null });
	}

	let linked: Stripe.Subscription;
	if (sub.metadata?.organization_id === orgId) {
		linked = sub;
	} else {
		const [org] = await getServiceDb()
			.select({ name: organization.name })
			.from(organization)
			.where(eq(organization.id, orgId))
			.limit(1);
		// Customer first, subscription second: X's `organization_id` is what a retried link and the
		// webhook read, so it is written LAST — a failure between the two leaves X unlinked.
		await fence();
		await getPurchaseStripe().customers.update(customerId, {
			name: org?.name,
			metadata: { created_by: userId, organization_id: orgId },
		});
		await fence();
		linked = await getPurchaseStripe().subscriptions.update(sub.id, {
			metadata: { created_by: userId, organization_id: orgId },
		});
	}

	// An "ignored" sync beside a row naming X itself is #5549's rank guard keeping a later state (C76),
	// and X is linked.
	if ((await syncSubscriptionToBilling(linked)) === "ignored") {
		const after = await getOrgBilling(orgId);
		if (namesOtherLivePlan(after, sub.id)) {
			return refuseBesideLivePlan({ userId, orgId, sub, customerId, lease, rowSubscriptionId: after?.stripeSubscriptionId ?? null });
		}
	}

	// After the sync, never before: the row does not exist until then.
	if (input.payer?.capacity && input.payer.billingCountry) {
		await getServiceDb()
			.update(organizationBilling)
			.set({
				payerCapacity: input.payer.capacity,
				billingCountry: input.payer.billingCountry.trim().toUpperCase(),
				updatedAt: new Date(),
			})
			.where(eq(organizationBilling.organizationId, orgId));
	}
	await markPendingOrgSetupLinked(userId, sub.id, orgId);
	return { kind: "linked", sub: linked };
}

/**
 * The refusal beside the org's other live, paid plan Y (§5.6; C80). It never syncs X, marks the setup
 * linked or writes payer facts. It opens a hold on X in `needs_operator` with `open_note = link_refused`
 * — which T2o never adopts, and which blocks `userId`'s next create-a-team purchase — and alerts with X
 * as the subject, recording `alerted_at` only when the alert reached a channel. The setup stays OPEN with
 * `refused_reason = 'org_has_plan'` (I16): the hold is open, and its release decides the setup.
 *
 * When a hold on X is already open (an earlier refusal of the same X, or the hold `payment-holds
 * release` is releasing), nothing new is opened and no second alert is raised; the clause claims the
 * alert only when that hold, if it is `userId`'s, alerted in its current state entry. X with no invoice
 * cannot be held (a hold names its invoice): it is alerted on and the setup stays open. A lost lease is
 * thrown, with nothing written.
 */
async function refuseBesideLivePlan(input: {
	userId: string;
	orgId: string;
	sub: Stripe.Subscription;
	customerId: string;
	lease: PurchaseLease;
	rowSubscriptionId: string | null;
}): Promise<SetupLinkResult> {
	const { userId, sub, customerId, lease } = input;
	const raise = () =>
		alertPaymentNeedsSupport({
			subscriptionId: sub.id,
			customerId,
			paymentIntentId: null,
			context: "link_refused",
			detail: `the link to team ${input.orgId} was refused because its billing row holds another live subscription (${input.rowSubscriptionId ?? "unknown"}), so this one is unlinked and keeps renewing beside it. Refund it, or move it to the right team.`,
		});
	let hold: PaymentHoldRow | null = null;
	let alerted = false;
	const invoiceId = latestInvoiceOf(sub);
	if (invoiceId) {
		const opened = await openHold(lease, {
			subscriptionId: sub.id,
			customerId,
			payerKey: userId,
			invoiceId,
			state: "needs_operator",
			nextCheckAt: new Date(Date.now() + OPERATOR_CHECK_MS),
			openedBy: "link",
			openedByUserId: userId,
			openNote: LINK_REFUSED_NOTE,
		});
		if (opened.kind === "lease_lost") throw new PurchaseLeaseLostError(lease.key);
		if (opened.kind === "opened") {
			hold = opened.hold;
			alerted = await raise();
			if (alerted) {
				hold = (await writeHoldState(lease, { id: hold.id, version: hold.version }, { alertedAt: new Date() })) ?? hold;
			}
		} else {
			hold = opened.hold && opened.hold.payer_key === userId ? opened.hold : null;
			alerted = hold !== null && alertedThisEntry(hold);
		}
	} else {
		alerted = await raise();
	}
	await recordSetupRefusal({ userId, subscriptionId: sub.id, refused: "org_has_plan", close: false });
	logBillingEvent("billing.new_org_link.refused", {
		subscription_id: sub.id,
		customer_id: customerId,
		org_id: input.orgId,
		org_subscription_id: input.rowSubscriptionId,
		hold_id: hold?.id ?? null,
	});
	return { kind: "refused", clause: `${LINK_REFUSED_ORG_HAS_PLAN}${alerted ? LINK_REFUSED_ALERTED : ""}`, hold };
}

/**
 * Whether `userId` may manage billing in `orgId`, asked with no session (§5.6 "When a hold ends"): the
 * scope `userId` resolves to when it names `orgId` must BE `orgId` (a substituted scope is a no), and
 * the PDP must allow `manage_billing` there. It is the question the session's link asks with
 * `authorizeInOrg`, asked about the setup's creator rather than about whoever runs the caller, and
 * asked with `can`, so nothing is recorded.
 */
async function holdsManageBilling(userId: string, orgId: string): Promise<boolean> {
	const actor = await getActiveScope(userId, orgId);
	if (actor.orgId !== orgId) return false;
	return (await getPdp().can(actor, "manage_billing", { type: "billing" })).allowed;
}

/** What a re-link did: the core's result, or why the core was not run. */
export type RelinkResult =
	| SetupLinkResult
	| { kind: "no_setup" }
	| { kind: "no_org" }
	| { kind: "not_linked"; why: string };

/**
 * Runs the link's core for the open setup `row` and the org `orgId`, with no session, under the setup
 * creator's lease (§5.6 "When a hold ends"). It checks what the session's link checks — the customer's
 * `created_by` is the creator, X names no org but `orgId`, the creator holds `manage_billing` in `orgId`
 * — and also that X's own `metadata.created_by` is the creator. A check that fails runs no core: the
 * operator is alerted with X as the subject, and the setup stays open. An X that reads ended is not linked, and not
 * alerted on here: the setup closer closes such a setup. A Stripe read that fails is thrown.
 */
async function relinkSetup(
	lease: PurchaseLease,
	row: PendingOrgSetupRow,
	orgId: string,
	alert: HoldMachineDeps["alert"],
): Promise<RelinkResult> {
	if (lease.key !== payerLeaseKey(row.user_id)) {
		throw new Error(`relinkSetup: the setup of ${row.user_id} needs that user's lease, not ${lease.key}.`);
	}
	if (row.linked_at || row.closed_at) return { kind: "no_setup" };
	const stripe = getPurchaseStripe();
	const sub = await stripe.subscriptions.retrieve(row.subscription_id);
	if (ENDED_STATUSES.has(sub.status)) return { kind: "not_linked", why: `it reads ${sub.status}` };
	const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
	const customer = await stripe.customers.retrieve(customerId);
	const linkedTo = sub.metadata?.organization_id;
	let why: string | null = null;
	if (sub.metadata?.created_by !== row.user_id) why = "its metadata names another creator";
	else if (customer.deleted || customer.metadata?.created_by !== row.user_id) why = "its customer was not minted by the setup's creator";
	else if (linkedTo && linkedTo !== orgId) why = `it is already linked to another team (${linkedTo})`;
	else if (!(await holdsManageBilling(row.user_id, orgId))) why = `its creator no longer holds manage_billing in team ${orgId}`;
	if (why) {
		await alert({
			subscriptionId: sub.id,
			customerId,
			paymentIntentId: null,
			detail: `its payment hold was released as adopted and its team setup could not be re-linked: ${why}. The setup stays open; link it to the team, or refund it, by hand.`,
		});
		return { kind: "not_linked", why };
	}
	return linkSetupToOrg({ userId: row.user_id, orgId, sub, customerId, lease });
}

/** The hold was released `adopted`. */
function isAdopted(hold: PaymentHoldRow): boolean {
	return hold.state === "released" && hold.release_reason === "adopted";
}

/**
 * The org a sessionless re-link may link `row` to, read-only: by `created_org_id`, else by the org whose
 * server-stamped marker names the subscription and the creator (`findSetupOrg`'s two ways, without its
 * membership repair). `none`: no org names the setup — none was made, or it was deleted (deleting the
 * team nulls `created_org_id` and removes the marker with the org row) — so the setup waits for the
 * creator's resume. `unusable`: the org exists, but the creator is not an ACTIVE member of it (removed,
 * suspended, or the org has no members at all) — nothing here adds them; or `created_org_id` named an org
 * that was gone by the next read, which only a deletion racing this read produces.
 */
async function relinkOrgOf(
	row: PendingOrgSetupRow,
): Promise<{ kind: "none" } | { kind: "org"; id: string } | { kind: "unusable"; why: string }> {
	const db = getServiceDb();
	let orgId = row.created_org_id;
	if (orgId) {
		const [found] = await db.select({ id: organization.id }).from(organization).where(eq(organization.id, orgId)).limit(1);
		if (!found) return { kind: "unusable", why: `its recorded team ${orgId} no longer exists` };
	} else {
		const candidates = await db
			.select({ id: organization.id, metadata: organization.metadata })
			.from(organization)
			.where(like(organization.metadata, `%${row.subscription_id}%`))
			.orderBy(asc(organization.createdAt));
		const marked = candidates.find(
			(o) => newOrgSubscriptionIdOf(o.metadata) === row.subscription_id && newOrgCreatedByOf(o.metadata) === row.user_id,
		);
		if (!marked) return { kind: "none" };
		orgId = marked.id;
	}
	const members = await db
		.select({ userId: member.userId, status: member.status })
		.from(member)
		.where(eq(member.organizationId, orgId));
	if (members.length === 0) return { kind: "unusable", why: `its team ${orgId} has no members` };
	if (!members.some((m) => m.userId === row.user_id && m.status === "active")) {
		return { kind: "unusable", why: `its creator is no longer an active member of team ${orgId}` };
	}
	return { kind: "org", id: orgId };
}

/**
 * §5.6 "When a hold ends", for an `adopted` hold under its payer's lease: the payer's open setup for the
 * hold's subscription is re-linked (`relinkSetup`) to its org (`relinkOrgOf`, read-only). With no open
 * setup, or no org naming it (none made, or deleted), nothing runs: such a setup stays open for the
 * creator's resume, and the sweeper owes its Q3 email. An org the creator cannot act in runs no core either: the operator is alerted with X as the subject, and the
 * setup stays open (`not_linked`). Called by the visit here, the create-a-team purchase and `payment-holds
 * release`.
 */
export async function relinkAdoptedSetup(
	lease: PurchaseLease,
	hold: Pick<PaymentHoldRow, "payer_key" | "subscription_id" | "customer_id">,
	alert: HoldMachineDeps["alert"],
): Promise<RelinkResult> {
	const row = await pendingOrgSetupFor(hold.payer_key, hold.subscription_id);
	if (!row || row.linked_at || row.closed_at) return { kind: "no_setup" };
	const org = await relinkOrgOf(row);
	if (org.kind === "none") return { kind: "no_org" };
	if (org.kind === "unusable") {
		await alert({
			subscriptionId: hold.subscription_id,
			customerId: hold.customer_id,
			paymentIntentId: null,
			detail: `its payment hold was released as adopted and its team setup could not be re-linked: ${org.why}. The setup stays open; link it to a team, or refund it, by hand.`,
		});
		return { kind: "not_linked", why: org.why };
	}
	return relinkSetup(lease, row, org.id, alert);
}

/**
 * The visit's re-link of an adopted hold. The sweeper never visits that hold again — it is released — so
 * a failure is logged AND alerted with X as the subject, and the setup stays open.
 */
async function relinkAfterVisit(lease: PurchaseLease, hold: PaymentHoldRow, deps: SweepDeps): Promise<RelinkResult | null> {
	try {
		return await relinkAdoptedSetup(lease, hold, deps.alert);
	} catch (err) {
		console.error(`[billing] payment-hold sweeper could not re-link the setup of adopted hold ${hold.id}:`, err);
		await deps.alert({
			subscriptionId: hold.subscription_id,
			customerId: hold.customer_id,
			paymentIntentId: null,
			detail: `its payment hold ${hold.id} was released as adopted, and re-linking its team setup failed (${err instanceof Error ? err.message : String(err)}). The setup stays open; link it to the team, or refund it, by hand.`,
		});
		return null;
	}
}

/** The predicate of a hold that is due (§3.2 E1 (b)): scheduled now, or nudged since it was observed. */
function dueNow(): SQL | undefined {
	return and(
		ne(paymentHolds.state, "released"),
		or(lte(paymentHolds.next_check_at, sql`now()`), sql`${paymentHolds.nudged_at} > ${paymentHolds.observed_at}`),
	);
}

/** Options of one tick. */
export interface SweepOptions {
	/** Only this payer's holds and emails (the operator's `reconcile --payer`). */
	payerKey?: string;
	deps?: Partial<SweepDeps>;
}

/**
 * One sweeper tick (§5.4): advances every due open hold under its payer's lease, raises the age alerts,
 * then sends the Q3 emails. Never throws for one hold's failure; a database failure in the selection
 * itself is thrown to the loop's supervisor.
 */
export async function runPaymentHoldSweep(options: SweepOptions = {}): Promise<SweepResult> {
	const deps: SweepDeps = { ...liveSweepDeps(), ...options.deps };
	const result: SweepResult = { due: 0, advanced: 0, released: 0, busy: 0, stale: 0, ageAlerts: 0, notices: 0 };

	const due = await getServiceDb()
		.select()
		.from(paymentHolds)
		.where(and(dueNow(), options.payerKey ? eq(paymentHolds.payer_key, options.payerKey) : undefined))
		// Oldest first: by the moment the hold became due — its nudge when that is what made it due,
		// else its schedule.
		.orderBy(
			asc(
				sql`CASE WHEN ${paymentHolds.nudged_at} > ${paymentHolds.observed_at} THEN LEAST(${paymentHolds.nudged_at}, ${paymentHolds.next_check_at}) ELSE ${paymentHolds.next_check_at} END`,
			),
			asc(paymentHolds.created_at),
		)
		.limit(SWEEP_BATCH);
	result.due = due.length;

	for (const hold of due) {
		try {
			const visit = await visitHold(hold, deps);
			if (visit.kind === "busy") {
				result.busy += 1;
				continue;
			}
			if (visit.kind === "gone") continue;
			result.advanced += 1;
			if (visit.result.outcome === "released") result.released += 1;
			if (visit.result.outcome === "stale" || visit.result.outcome === "lease_lost") result.stale += 1;
			if (visit.ageAlerted) result.ageAlerts += 1;
		} catch (err) {
			// One hold's failure (a database error mid-write) must not starve the rest of the batch; the
			// hold stays open and due, so the next tick retries it.
			console.error(`[billing] payment-hold sweeper failed on hold ${hold.id}:`, err);
		}
	}

	result.notices = await sendDueHoldNotices({ deliver: deps.deliver, payerKey: options.payerKey });
	return result;
}

declare global {
	var __alethiaPaymentHoldSweeper: ReturnType<typeof setInterval> | undefined;
	var __alethiaPaymentHoldSweepRun:
		| { running: boolean; again: boolean; wake: ReturnType<typeof setTimeout> | null }
		| undefined;
}

/** The in-process tick state, shared across HMR reloads. */
function runState(): { running: boolean; again: boolean; wake: ReturnType<typeof setTimeout> | null } {
	globalThis.__alethiaPaymentHoldSweepRun ??= { running: false, again: false, wake: null };
	return globalThis.__alethiaPaymentHoldSweepRun;
}

/**
 * Runs one supervised tick unless one is already running in this process. A woken tick that finds one
 * running asks for exactly one more after it (`again`), so a nudge that lands mid-tick is not lost; an
 * interval tick that finds one running is simply skipped.
 */
async function tick(fromWake: boolean): Promise<void> {
	const state = runState();
	if (state.running) {
		if (fromWake) state.again = true;
		return;
	}
	state.running = true;
	try {
		await superviseLoop(PAYMENT_HOLD_SWEEPER_LOOP_ID, () => runPaymentHoldSweep());
	} finally {
		state.running = false;
	}
	if (state.again) {
		state.again = false;
		await tick(false);
	}
}

/**
 * Starts the sweeper in-process every `SWEEP_INTERVAL_MS` (idempotent across HMR). A no-op with no
 * database configured. With no Stripe key and no hold, a tick selects nothing and never builds a client.
 */
export function startPaymentHoldSweeper(): void {
	if (globalThis.__alethiaPaymentHoldSweeper) return;
	if (!process.env.ALETHIA_DATABASE_URL) return;
	registerLoop(PAYMENT_HOLD_SWEEPER_LOOP_ID, { intervalMs: SWEEP_INTERVAL_MS });
	globalThis.__alethiaPaymentHoldSweeper = setInterval(() => {
		void tick(false);
	}, SWEEP_INTERVAL_MS);
}

/**
 * Schedules one immediate tick (§5.4), coalesced: many wakes before it starts make one tick, and a wake
 * during a running tick makes one more after it. Never awaited by its caller and never throws.
 */
export function wakePaymentHoldSweeper(): void {
	if (!process.env.ALETHIA_DATABASE_URL) return;
	const state = runState();
	if (state.wake) return;
	state.wake = setTimeout(() => {
		state.wake = null;
		void tick(true);
	}, 0);
}
