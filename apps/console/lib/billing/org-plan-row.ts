// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The org-plan row's reconciliations from a fresh Stripe read, and the two-live detector (ADR 0004 D4,
// D6). The guarded write (`writeSubscriptionToBilling`, lib/billing/queries.ts) is unchanged: it decides
// from the row's STORED status. What it cannot see, these make one Stripe read to find out:
//
//   R1   the subscription the row names ENDED (`customer.subscription.deleted` applied): list the org's
//        customer and name a live org-plan sibling, `active` first, then `trialing`, then any other live
//        one. Without it an org paying for X sits on `community` until X's next event.
//   R2   a LIVE org-plan subscription's write was REFUSED beside a different subscription Y the row
//        names: retrieve Y. Ended, Y's end is written and X is written again. Live, the row stays on Y
//        and the two-live alert is raised (D6a).
//   D6b  a write REPLACED a live subscription (a paid X over a `past_due` Y, or over a live off-Stripe
//        grant): alert. No Stripe call; `syncSubscriptionToBilling` runs it for every caller.
//   D6b′ a paid X replaced a different Y the row stored as `none` (`mapStatus` stores both `incomplete`
//        and `paused` that way): retrieve Y and alert only when it reads `paused`, which is live.
//   D6c  R1 found two or more live siblings: it names one and alerts.
//
// R1, R2 and D6b′ run in the webhook handler (lib/billing/webhook-handler.ts) after its own syncs, and
// nowhere else. Nothing here cancels, refunds or voids anything: which of two live plans the customer
// keeps is a person's call (ADR 0004 D6, Q4). A failed read in R1 or R2 throws, so the event fails
// before any email and Stripe redelivers it; the two-live alert never throws.

import type Stripe from "stripe";
import { alertOperator } from "@/lib/billing/operator-alert";
import { isManualGrantExpired } from "@/lib/billing/plan";
import type { PlanSlotBefore, PlanSlotWrite } from "@/lib/billing/queries";
import {
	isOrgPlanSubscription,
	type SyncOptions,
	type SyncOutcome,
	syncSubscriptionToBilling,
} from "@/lib/billing/sync";

/** Stripe statuses under which a subscription still exists and may bill (ADR 0004 §2, "Live"). */
const LIVE_STATUSES: ReadonlySet<string> = new Set(["active", "trialing", "past_due", "unpaid", "paused"]);

/** Stripe statuses that are paid (ADR 0004 §2, "Paid"). */
const PAID_STATUSES: ReadonlySet<string> = new Set(["active", "trialing"]);

/** Stripe statuses that are ended: terminal, never billing again. */
const ENDED_STATUSES: ReadonlySet<string> = new Set(["canceled", "incomplete_expired"]);

/** Row statuses under which a stored slot holds a live plan (`mapStatus` folds `unpaid` into `past_due`). */
const STORED_LIVE_STATUSES: ReadonlySet<string> = new Set(["active", "trialing", "past_due"]);

/** The Stripe page size R1 lists with. */
const LIST_PAGE = 100;

/** The Stripe reads R1, R2 and D6b′ make, and nothing else: no write is reachable through this. */
export interface OrgPlanStripe {
	subscriptions: {
		list(params: Stripe.SubscriptionListParams): PromiseLike<{ data: Stripe.Subscription[]; has_more: boolean }>;
		retrieve(id: string): PromiseLike<Stripe.Subscription>;
	};
}

/**
 * Whether `sub` is an org-plan subscription of `orgId` (ADR 0004 §2): its OWN metadata names the org and
 * carries no `product_type`, and `isOrgPlanSubscription` (lib/billing/sync.ts) does not place its plan
 * line on an AI price. Another org's subscription on a shared customer is not one; the customer is never
 * evidence.
 */
export function isOrgPlanSubscriptionOf(sub: Stripe.Subscription, orgId: string): boolean {
	return (
		sub.metadata?.organization_id === orgId &&
		!sub.metadata?.product_type &&
		isOrgPlanSubscription(sub)
	);
}

/** Whether a Stripe subscription status is live (ADR 0004 §2). */
function isLiveStatus(status: string): boolean {
	return LIVE_STATUSES.has(status);
}

/** Whether a Stripe subscription status is paid: `active` or `trialing` (ADR 0004 §2). */
export function isPaidStatus(status: string): boolean {
	return PAID_STATUSES.has(status);
}

/** One side of a two-live finding: a Stripe subscription, or an off-Stripe grant (`subscriptionId` null). */
export interface TwoLiveParty {
	subscriptionId: string | null;
	/** The status as read: Stripe's for a fresh read, the row's for a stored slot. */
	status: string;
	/** Stripe's `created` (seconds), when the caller read the subscription; null otherwise. */
	created: number | null;
}

/** A subscription as a two-live party, from a Stripe read. */
function partyOf(sub: Stripe.Subscription): TwoLiveParty {
	return { subscriptionId: sub.id, status: sub.status, created: sub.created };
}

/** A stored slot as a two-live party: its subscription id (null for a grant) and stored status. */
function partyOfSlot(slot: PlanSlotBefore): TwoLiveParty {
	return { subscriptionId: slot.subscriptionId, status: slot.status, created: null };
}

/** How a party reads in the alert's summary. */
function describeParty(p: TwoLiveParty): string {
	return p.subscriptionId
		? `subscription ${p.subscriptionId} (${p.status})`
		: `an off-Stripe grant (${p.status})`;
}

/**
 * The alert's subject: the newer subscription, so the alert rule's throttle collapses repeats of the same
 * pair. When both carry `created`, the later one; otherwise the first party that names a subscription
 * (callers pass the subscription being written first).
 */
function subjectOf(a: TwoLiveParty, b: TwoLiveParty): string {
	if (a.subscriptionId && b.subscriptionId && a.created !== null && b.created !== null) {
		return b.created > a.created ? b.subscriptionId : a.subscriptionId;
	}
	return a.subscriptionId ?? b.subscriptionId ?? "unknown";
}

/**
 * The two-live detector's one report (ADR 0004 D6): logs `billing.org_plan.two_live` with both parties,
 * and raises `system.platform.payment_needs_support` through `alertOperator` with its own summary,
 * never `alertPaymentNeedsSupport`'s "which the purchase flow cancelled" text. The subject is the newer
 * subscription. `detail` adds a sentence (D6b′'s "could not be read"). It never cancels anything, and
 * never throws: a report must not fail the write or the event that found it.
 */
export async function reportTwoLive(
	orgId: string,
	a: TwoLiveParty,
	b: TwoLiveParty,
	detail?: string,
): Promise<void> {
	try {
		console.info(
			JSON.stringify({
				event: "billing.org_plan.two_live",
				organization_id: orgId,
				subscription_a: a.subscriptionId,
				status_a: a.status,
				subscription_b: b.subscriptionId,
				status_b: b.status,
			}),
		);
		const summary =
			`Organization ${orgId} has two live plans: ${describeParty(a)} and ${describeParty(b)}. ` +
			"Nothing was cancelled; decide in Stripe which one the customer keeps." +
			(detail ? ` ${detail}` : "");
		await alertOperator({
			title: "An organization has two live plans",
			subject: { type: "stripe_subscription", id: subjectOf(a, b) },
			summary,
		});
	} catch (err) {
		console.error(`[billing] two-live report failed for org ${orgId}:`, err);
	}
}

/** Whether a stored slot holds a live plan: a live subscription, or a live, unexpired off-Stripe grant. */
function slotIsLive(slot: PlanSlotBefore): boolean {
	if (!STORED_LIVE_STATUSES.has(slot.status)) return false;
	return (
		slot.subscriptionId !== null ||
		!isManualGrantExpired({ stripeSubscriptionId: null, currentPeriodEnd: slot.currentPeriodEnd })
	);
}

/**
 * D6b: after a guarded write of `x` APPLIED, alerts when it replaced a different slot that was live — a
 * `past_due` subscription, which keeps dunning in Stripe, or a live off-Stripe grant. The guard lets only
 * a paid `x` do either (lib/billing/queries.ts). No Stripe call. `syncSubscriptionToBilling` calls this,
 * so every caller of the sync is covered.
 */
export async function reportReplacedLivePlan(
	orgId: string,
	x: Stripe.Subscription,
	before: PlanSlotBefore | null,
): Promise<void> {
	if (!before || before.subscriptionId === x.id || !slotIsLive(before)) return;
	await reportTwoLive(orgId, partyOf(x), partyOfSlot(before));
}

/**
 * R1's choice among the live org-plan siblings: the newest `active` one by `created`, else the newest
 * `trialing` one, else the newest other live one. `active` comes first so a card-less trial is never
 * named over a plan the customer pays for. Null when `live` is empty.
 */
export function chooseSuccessor(live: readonly Stripe.Subscription[]): Stripe.Subscription | null {
	const newest = (subs: Stripe.Subscription[]): Stripe.Subscription | null =>
		subs.reduce<Stripe.Subscription | null>((best, s) => (!best || s.created > best.created ? s : best), null);
	return (
		newest(live.filter((s) => s.status === "active")) ??
		newest(live.filter((s) => s.status === "trialing")) ??
		newest([...live])
	);
}

/** Every subscription on `customerId`, in every status, fully paged. A failed page throws. */
async function listAllSubscriptions(stripe: OrgPlanStripe, customerId: string): Promise<Stripe.Subscription[]> {
	const subs: Stripe.Subscription[] = [];
	let startingAfter: string | undefined;
	for (;;) {
		const page = await stripe.subscriptions.list({
			customer: customerId,
			status: "all",
			limit: LIST_PAGE,
			...(startingAfter ? { starting_after: startingAfter } : {}),
		});
		subs.push(...page.data);
		const last = page.data.at(-1);
		if (!page.has_more || !last) return subs;
		startingAfter = last.id;
	}
}

/** The id of the customer a subscription belongs to. */
function customerIdOf(sub: Stripe.Subscription): string {
	return typeof sub.customer === "string" ? sub.customer : sub.customer.id;
}

/**
 * R1, after `customer.subscription.deleted` for `ended` APPLIED to its org's row. When `ended` is an
 * org-plan subscription of its org, lists its customer fully and names one live org-plan sibling (see
 * `chooseSuccessor`) by syncing it with no event time: the row now reads `canceled`, which is not live,
 * so the guard lets a different subscription take it. With two or more live, it also raises the
 * two-live alert (D6c). Returns the subscription it named, or null when there was none to name (the row
 * then stays `canceled` / `community`). A failed list throws.
 */
export async function repointAfterEnd(
	stripe: OrgPlanStripe,
	ended: Stripe.Subscription,
): Promise<Stripe.Subscription | null> {
	const orgId = ended.metadata?.organization_id;
	if (!orgId || !isOrgPlanSubscriptionOf(ended, orgId)) return null;
	const live = (await listAllSubscriptions(stripe, customerIdOf(ended))).filter(
		(s) => s.id !== ended.id && isOrgPlanSubscriptionOf(s, orgId) && isLiveStatus(s.status),
	);
	const named = chooseSuccessor(live);
	if (!named) return null;
	await syncSubscriptionToBilling(named);
	const others = live.filter((s) => s.id !== named.id);
	const other = others.reduce<Stripe.Subscription | null>(
		(best, s) => (!best || s.created > best.created ? s : best),
		null,
	);
	if (other) await reportTwoLive(orgId, partyOf(named), partyOf(other));
	return named;
}

/**
 * R2, D6a and D6b′, after the webhook synced `x`, a subscription it had just read from Stripe. `write` is
 * what the guarded org-plan write reported (null when the sync never reached the org-plan slot: no
 * `organization_id`, or the AI product).
 *
 * - Refused, `x` live, and the row names a different subscription Y: retrieve Y. Ended → sync Y (its
 *   `canceled` applies to the row that names it), then sync `x` again with the same event time, which
 *   now applies. Live → the row stays on Y, and the two-live alert names `x` and Y (D6a).
 * - Refused, `x` live, and the row names no subscription: nothing to re-read; when the row is a live
 *   off-Stripe grant, the two-live alert names `x` and the grant.
 * - Applied, `x` paid, and the row named a different Y it stored as `none`: retrieve Y, and alert when Y
 *   reads `paused` (D6b′). A failed retrieve alerts anyway, saying Y could not be read: the row now names
 *   `x`, so a redelivery could not find Y again. It never fails the event.
 *
 * A failed retrieve in R2 throws, before anything past the guarded write of `x` has changed.
 */
export async function reconcileAfterSync(
	stripe: OrgPlanStripe,
	x: Stripe.Subscription,
	outcome: SyncOutcome,
	write: PlanSlotWrite | null,
	opts: SyncOptions,
): Promise<void> {
	const orgId = x.metadata?.organization_id;
	const before = write?.before;
	if (!orgId || !before || before.subscriptionId === x.id || !isOrgPlanSubscriptionOf(x, orgId)) return;

	if (outcome === "ignored") {
		if (!isLiveStatus(x.status)) return;
		if (before.subscriptionId === null) {
			if (slotIsLive(before)) await reportTwoLive(orgId, partyOf(x), partyOfSlot(before));
			return;
		}
		const y = await stripe.subscriptions.retrieve(before.subscriptionId);
		if (ENDED_STATUSES.has(y.status)) {
			await syncSubscriptionToBilling(y);
			await syncSubscriptionToBilling(x, { eventAt: opts.eventAt });
		} else if (isLiveStatus(y.status)) {
			await reportTwoLive(orgId, partyOf(x), partyOf(y));
		}
		return;
	}

	if (!isPaidStatus(x.status) || before.subscriptionId === null || before.status !== "none") return;
	const replacedId = before.subscriptionId;
	let y: Stripe.Subscription;
	try {
		y = await stripe.subscriptions.retrieve(replacedId);
	} catch (err) {
		console.error(`[billing] D6b′ could not read replaced subscription ${replacedId}:`, err);
		await reportTwoLive(
			orgId,
			partyOf(x),
			{ subscriptionId: replacedId, status: "unreadable", created: null },
			`Subscription ${replacedId} could not be read from Stripe, so it may still be paused and live.`,
		);
		return;
	}
	if (y.status === "paused") await reportTwoLive(orgId, partyOf(x), partyOf(y));
}
