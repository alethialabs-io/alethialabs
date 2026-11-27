// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// `applyBillingEvent` — the provider-neutral write path for a normalized billing event
// (lib/billing/provider/types.ts). A provider's webhook verifies and normalizes; this decides what
// the event may change and writes it through a `BillingEventStore` (./store.ts is the Postgres one;
// the unit tests drive an in-memory one).
//
// Stripe still writes through its own handler (lib/billing/webhook-handler.ts → sync.ts), whose
// hold/lease machinery is not ported; a Stripe event handed here is refused, never half-applied.
// The slot columns below are Paddle's; a second MoR adapter adds its own.
//
// The rules, each enforced here and each with a test:
//
//   Org        The org is the one whose row already names the subscription. An org id from
//              custom_data is used ONLY when no row names it yet (first checkout), only if that org
//              exists, and only when something WE recorded ties that org to the event: the org's
//              stored Paddle customer, a `commerce_order` our checkout placed for the transaction, or
//              a transaction already mirrored for it. Without one the event is not applied: a
//              subscription event or a subscription's transaction is redelivered (the checkout's
//              transaction may simply not be mirrored yet), anything else is refused. custom_data
//              naming a different org than the row is refused and alerted.
//   Watermark  Each subscription slot keeps the provider's `occurred_at` of the newest event applied.
//              An older event is refused, so redelivery or out-of-order arrival never regresses the
//              row; a same-instant tie goes to the later lifecycle stage (none < live < canceled).
//   Terminal   A canceled subscription is never brought back by a (necessarily stale) live event.
//   One slot   A different subscription takes the slot only when the slot holds nothing live, or when
//              it is PAID (active/trialing) and the slot holds an unpaid `past_due` one or a
//              subscription-less grant — the same rule as Stripe's #5514 guard (lib/billing/queries.ts).
//              A replaced live subscription is alerted, never canceled: which one the customer keeps
//              is a person's call.
//   Stripe     A row with a LIVE Stripe subscription is never switched to the MoR provider: refused and
//              alerted. A dead Stripe subscription id is cleared so the row can say `paddle`.
//   Plan       The stored plan is the paid plan while active, trialing or past_due (past_due keeps it
//              so the 7-day grace in lib/billing/plan.ts `entitlementStatus` can grant it), else
//              community. A scheduled cancellation is stored in `cancel_effective_at` and the row
//              stays active until the provider's cancel event.
//   Money      Each transaction event upserts the `paddle_transaction` mirror under its own
//              watermark. A completed credit-pack transaction grants its credits once (keyed on the
//              transaction id). An approved full refund or a chargeback marks the mirror and zeroes
//              that pack's grant; a chargeback, a partial refund and a reversal alert the operator.

import { AI_CREDIT_PACKS } from "@/lib/billing/ai-credits";
import type { OperatorAlert } from "@/lib/billing/operator-alert";
import type {
	AdjustmentEvent,
	NormalizedBillingEvent,
	SubscriptionCanceledEvent,
	SubscriptionUpsertedEvent,
	TransactionCompletedEvent,
	TransactionPaymentFailedEvent,
	TransactionSnapshot,
	TransactionUpdatedEvent,
} from "@/lib/billing/provider/types";
import type { BillingProviderId } from "@/lib/db/schema/billing-provider";
import type { BillingStatus } from "@/lib/db/schema/enums";
import type { OrganizationBillingInsert } from "@/lib/db/schema/organization-billing";
import type { PaddleTransactionCustomData } from "@/types/jsonb.types";

/** The billing-row columns the guard decides from. */
export interface BillingRowState {
	organizationId: string;
	billingProvider: BillingProviderId | null;
	status: BillingStatus;
	aiSubscriptionStatus: BillingStatus;
	stripeSubscriptionId: string | null;
	aiStripeSubscriptionId: string | null;
	paddleSubscriptionId: string | null;
	paddleSubscriptionEventAt: Date | null;
	aiPaddleSubscriptionId: string | null;
	aiPaddleSubscriptionEventAt: Date | null;
}

/** The columns a subscription write may set. */
export type BillingRowPatch = Partial<Omit<OrganizationBillingInsert, "id" | "organizationId" | "createdAt">>;

/** The mirror row an adjustment needs. */
export interface TransactionMirrorState {
	organizationId: string;
	totalMinor: number;
	customData: PaddleTransactionCustomData | null;
}

/** One transaction event's mirror write. */
export interface TransactionMirrorWrite {
	organizationId: string;
	transactionId: string;
	subscriptionId: string | null;
	customerId: string | null;
	occurredAt: Date;
	snapshot: TransactionSnapshot;
}

/** The provider object ids an event names, for {@link BillingEventStore.orgHasRecordOf}. */
export interface ProviderRefs {
	transactionId: string | null;
	subscriptionId: string | null;
	customerId: string | null;
}

/** The persistence `applyBillingEvent` writes through. Every method is the service role's. */
export interface BillingEventStore {
	/** Whether an organization with this id exists. */
	orgExists(orgId: string): Promise<boolean>;
	/** The org whose row names this provider subscription in either slot, or null. */
	orgForSubscription(subscriptionId: string): Promise<string | null>;
	/** The org whose row holds this provider business id, or null. */
	businessOwner(businessId: string): Promise<string | null>;
	/**
	 * Whether a record of ours ties `orgId` to any of `refs`: the org's billing row holds that
	 * customer, a Paddle `commerce_order` of the org names that transaction or subscription, or the
	 * org's transaction mirror holds that transaction or a transaction of that subscription.
	 */
	orgHasRecordOf(orgId: string, refs: ProviderRefs): Promise<boolean>;
	/**
	 * Runs `fn` with the org's billing row locked (`FOR UPDATE`; null when the org has none) and a
	 * `write` that inserts or updates that row — one transaction, so no write lands in between.
	 */
	withLockedRow<T>(
		orgId: string,
		fn: (row: BillingRowState | null, write: (patch: BillingRowPatch) => Promise<void>) => Promise<T>,
	): Promise<T>;
	/** Upserts the transaction mirror unless a newer event already wrote it. True when it applied. */
	upsertTransaction(write: TransactionMirrorWrite): Promise<boolean>;
	/** The mirrored transaction, or null when it was never mirrored. */
	getTransaction(transactionId: string): Promise<TransactionMirrorState | null>;
	/** Stamps (or clears, with null) the refund / chargeback instants on a mirrored transaction. */
	markTransaction(transactionId: string, patch: { refundedAt?: Date | null; chargebackAt?: Date | null }): Promise<void>;
	/** Grants a credit pack once per transaction. True when this call granted it. */
	grantPackCredits(input: { orgId: string; userId: string; credits: number; transactionId: string }): Promise<boolean>;
	/** Zeroes the pack grant of a transaction; returns the credits taken back (0 when none). */
	reversePackCredits(transactionId: string): Promise<number>;
}

/** What `applyBillingEvent` needs besides the store. */
export interface ApplyDeps {
	store: BillingEventStore;
	alert: (alert: OperatorAlert) => Promise<unknown>;
	warn: (message: string, fields: Record<string, string | number | boolean | null>) => void;
}

/** What one event did. `refused` = deliberately not applied (a rule above); `ignored` = nothing to do. */
export interface ApplyResult {
	outcome: "applied" | "ignored" | "refused";
	reason?: string;
}

/**
 * Thrown when an event cannot be applied YET (an adjustment for a transaction not mirrored so far).
 * The route answers 500 so the provider redelivers it.
 */
export class RetryableBillingEventError extends Error {
	/** Builds the error; the message is safe to log. */
	constructor(message: string) {
		super(message);
		this.name = "RetryableBillingEventError";
	}
}

const LIVE: ReadonlySet<BillingStatus> = new Set(["active", "trialing", "past_due"]);
const PAID: ReadonlySet<BillingStatus> = new Set(["active", "trialing"]);

/** Where a status sits in one subscription's lifecycle: none → live → canceled. */
export function lifecycleRank(status: BillingStatus): number {
	if (status === "none") return 0;
	if (status === "canceled") return 2;
	return 1;
}

/** One slot's stored state, read off the row. */
interface SlotState {
	subscriptionId: string | null;
	status: BillingStatus;
	eventAt: Date | null;
}

/** The plan or AI slot of `row`, as the MoR provider's columns hold it. */
function slotOf(row: BillingRowState | null, slot: "plan" | "ai"): SlotState {
	if (!row) return { subscriptionId: null, status: "none", eventAt: null };
	return slot === "plan"
		? { subscriptionId: row.paddleSubscriptionId, status: row.status, eventAt: row.paddleSubscriptionEventAt }
		: { subscriptionId: row.aiPaddleSubscriptionId, status: row.aiSubscriptionStatus, eventAt: row.aiPaddleSubscriptionEventAt };
}

/** Whether an event for the slot's OWN subscription may apply: never reviving, never older. */
export function sameSubscriptionMayApply(stored: SlotState, incoming: BillingStatus, occurredAt: Date): boolean {
	if (stored.status === "canceled" && incoming !== "canceled") return false;
	if (!stored.eventAt) return true;
	const a = stored.eventAt.getTime();
	const b = occurredAt.getTime();
	if (b > a) return true;
	return b === a && lifecycleRank(incoming) >= lifecycleRank(stored.status);
}

/** The decision for a subscription write over the locked row. */
export type SubscriptionDecision =
	| { apply: true; patch: BillingRowPatch; replacedLive: SlotState | null }
	| { apply: false; reason: string; alert: boolean };

/**
 * Decides an upsert over the locked row (pure). `businessOwner` is the org that already holds the
 * event's business id, so a second org's row never takes it (the column is unique).
 */
export function decideSubscriptionUpsert(
	row: BillingRowState | null,
	event: SubscriptionUpsertedEvent,
	businessOwner: string | null,
	orgId: string,
): SubscriptionDecision {
	const patch: BillingRowPatch = {};
	if (row && row.billingProvider !== "paddle") {
		const livePlan = row.stripeSubscriptionId != null && LIVE.has(row.status);
		const liveAi = row.aiStripeSubscriptionId != null && LIVE.has(row.aiSubscriptionStatus);
		if (livePlan || liveAi) {
			return { apply: false, reason: "the org has a live Stripe subscription", alert: true };
		}
		// Dead Stripe ids stay behind on a row after cancellation; the row cannot say `paddle` while
		// it names one (organization_billing_stripe_sub_is_stripe), so they go.
		if (row.stripeSubscriptionId != null) patch.stripeSubscriptionId = null;
		if (row.aiStripeSubscriptionId != null) patch.aiStripeSubscriptionId = null;
	}

	// A dead Stripe subscription in the plan slot leaves its status behind; it is not this provider's.
	const stripeOwnedPlan = row != null && row.billingProvider !== "paddle" && row.stripeSubscriptionId != null;
	const stripeOwnedAi = row != null && row.billingProvider !== "paddle" && row.aiStripeSubscriptionId != null;
	const stored = slotOf(row, event.slot);
	const storedStatus: BillingStatus =
		(event.slot === "plan" && stripeOwnedPlan) || (event.slot === "ai" && stripeOwnedAi) ? "none" : stored.status;

	let replacedLive: SlotState | null = null;
	if (stored.subscriptionId === event.subscriptionId) {
		if (!sameSubscriptionMayApply(stored, event.status, event.occurredAt)) {
			return { apply: false, reason: "an equal or newer event was already applied, or it is canceled", alert: false };
		}
	} else {
		const slotFree = !LIVE.has(storedStatus);
		const supersedes = PAID.has(event.status) && (stored.subscriptionId == null || storedStatus === "past_due");
		if (!slotFree && !supersedes) {
			return {
				apply: false,
				reason: "the slot names a different live subscription it does not supersede",
				alert: PAID.has(event.status),
			};
		}
		// A local card-less trial (lib/billing/trial/local.ts: `trialing`, no subscription) is what a
		// checkout converts — replacing it is the expected outcome, not something to alert on.
		const convertsLocalTrial = event.slot === "plan" && stored.subscriptionId == null && storedStatus === "trialing";
		if (!slotFree && !convertsLocalTrial) replacedLive = { ...stored, status: storedStatus };
	}

	const keepsPlan = LIVE.has(event.status);
	patch.billingProvider = "paddle";
	if (event.customerId) patch.paddleCustomerId = event.customerId;
	if (event.addressId) patch.paddleAddressId = event.addressId;
	if (event.businessId && (businessOwner == null || businessOwner === orgId)) patch.paddleBusinessId = event.businessId;

	const eventAt =
		stored.subscriptionId === event.subscriptionId && stored.eventAt && stored.eventAt > event.occurredAt
			? stored.eventAt
			: event.occurredAt;

	if (event.slot === "plan") {
		patch.paddleSubscriptionId = event.subscriptionId;
		patch.paddleSubscriptionEventAt = eventAt;
		patch.status = event.status;
		patch.plan = keepsPlan && event.plan ? event.plan : "community";
		patch.seats = event.seats;
		patch.currentPeriodStart = event.currentPeriodStart;
		patch.currentPeriodEnd = keepsPlan ? event.currentPeriodEnd : null;
		patch.cancelEffectiveAt = event.cancelEffectiveAt;
	} else {
		patch.aiPaddleSubscriptionId = event.subscriptionId;
		patch.aiPaddleSubscriptionEventAt = eventAt;
		patch.aiSubscriptionStatus = event.status;
		// No grace on the AI tier: only a paid subscription keeps it (effectiveAiTier's rule).
		patch.aiTier = PAID.has(event.status) && event.aiTier ? event.aiTier : "ai_free";
	}
	return { apply: true, patch, replacedLive };
}

/** Decides a cancellation over the locked row (pure): only the row naming that subscription moves. */
export function decideSubscriptionCanceled(
	row: BillingRowState | null,
	event: SubscriptionCanceledEvent,
): SubscriptionDecision {
	const stored = slotOf(row, event.slot);
	if (stored.subscriptionId !== event.subscriptionId) {
		return { apply: false, reason: "no row names this subscription", alert: false };
	}
	if (!sameSubscriptionMayApply(stored, "canceled", event.occurredAt)) {
		return { apply: false, reason: "a newer event was already applied", alert: false };
	}
	const eventAt = stored.eventAt && stored.eventAt > event.occurredAt ? stored.eventAt : event.occurredAt;
	if (event.slot === "plan") {
		return {
			apply: true,
			replacedLive: null,
			patch: {
				status: "canceled",
				plan: "community",
				currentPeriodEnd: null,
				cancelEffectiveAt: null,
				paddleSubscriptionEventAt: eventAt,
			},
		};
	}
	return {
		apply: true,
		replacedLive: null,
		patch: { aiSubscriptionStatus: "canceled", aiTier: "ai_free", aiPaddleSubscriptionEventAt: eventAt },
	};
}

/** Why an event's org could not be resolved. */
type UnresolvedReason = "mismatch" | "unknown_org" | "no_org" | "unrecorded_org";

/**
 * The org an event belongs to: the row already naming its subscription wins; otherwise the
 * custom_data org, if it exists and {@link BillingEventStore.orgHasRecordOf} ties it to `refs`.
 * `mismatch` when custom_data names a different org than that row; `unrecorded_org` when the
 * custom_data org exists but nothing of ours ties it to the event.
 */
async function resolveOrg(
	store: BillingEventStore,
	refs: ProviderRefs,
	claimedOrgId: string | null,
): Promise<{ orgId: string } | { orgId: null; reason: UnresolvedReason }> {
	const owner = refs.subscriptionId ? await store.orgForSubscription(refs.subscriptionId) : null;
	if (owner) {
		if (claimedOrgId && claimedOrgId !== owner) return { orgId: null, reason: "mismatch" };
		return { orgId: owner };
	}
	if (!claimedOrgId) return { orgId: null, reason: "no_org" };
	if (!(await store.orgExists(claimedOrgId))) return { orgId: null, reason: "unknown_org" };
	if (!(await store.orgHasRecordOf(claimedOrgId, refs))) return { orgId: null, reason: "unrecorded_org" };
	return { orgId: claimedOrgId };
}

/** A short, PII-free description of an event for alerts and logs. */
function describe(event: NormalizedBillingEvent): string {
	return `${event.provider} ${event.eventType} (${event.eventId})`;
}

/** Applies a subscription create/update. */
async function applyUpsert(event: SubscriptionUpsertedEvent, deps: ApplyDeps): Promise<ApplyResult> {
	const resolved = await resolveOrg(
		deps.store,
		{ transactionId: event.transactionId ?? null, subscriptionId: event.subscriptionId, customerId: event.customerId },
		event.organizationId,
	);
	if (resolved.orgId === null) {
		if (resolved.reason === "unrecorded_org" && LIVE.has(event.status)) {
			// A checkout's subscription events can arrive before its transaction is mirrored; once
			// that lands, the redelivery finds the record. Paddle gives up after its retry schedule.
			throw new RetryableBillingEventError(
				`subscription ${event.subscriptionId}: no record ties the custom_data organization to it yet`,
			);
		}
		if (resolved.reason === "mismatch" || (resolved.reason === "unknown_org" && LIVE.has(event.status))) {
			await deps.alert({
				title: "Paddle subscription for an unknown or different organization",
				subject: { type: "paddle_subscription", id: event.subscriptionId },
				summary: `${describe(event)}: subscription ${event.subscriptionId} was not applied (${resolved.reason}). Check the subscription's custom_data in Paddle.`,
			});
		}
		return { outcome: "refused", reason: resolved.reason };
	}
	const orgId = resolved.orgId;
	const businessOwner = event.businessId ? await deps.store.businessOwner(event.businessId) : null;
	const decision = await deps.store.withLockedRow(orgId, async (row, write) => {
		const d = decideSubscriptionUpsert(row, event, businessOwner, orgId);
		if (d.apply) await write(d.patch);
		return d;
	});
	if (!decision.apply) {
		deps.warn("[paddle] subscription event not applied", {
			event_id: event.eventId,
			subscription_id: event.subscriptionId,
			org_id: orgId,
			reason: decision.reason,
		});
		if (decision.alert) {
			await deps.alert({
				title: "Paddle subscription not applied beside a live subscription",
				subject: { type: "paddle_subscription", id: event.subscriptionId },
				summary: `${describe(event)}: org ${orgId} — ${decision.reason}. The customer may be paying twice; decide which subscription stays.`,
			});
		}
		return { outcome: "refused", reason: decision.reason };
	}
	if (decision.replacedLive) {
		await deps.alert({
			title: "Paddle subscription replaced a live plan",
			subject: { type: "paddle_subscription", id: event.subscriptionId },
			summary: `${describe(event)}: org ${orgId} — ${event.subscriptionId} (${event.status}) replaced ${decision.replacedLive.subscriptionId ?? "an off-provider grant"} (${decision.replacedLive.status}). Nothing was canceled.`,
		});
	}
	return { outcome: "applied" };
}

/** Applies a subscription cancellation. */
async function applyCanceled(event: SubscriptionCanceledEvent, deps: ApplyDeps): Promise<ApplyResult> {
	const orgId = await deps.store.orgForSubscription(event.subscriptionId);
	if (!orgId) return { outcome: "ignored", reason: "no row names this subscription" };
	const decision = await deps.store.withLockedRow(orgId, async (row, write) => {
		const d = decideSubscriptionCanceled(row, event);
		if (d.apply) await write(d.patch);
		return d;
	});
	if (!decision.apply) return { outcome: "refused", reason: decision.reason };
	return { outcome: "applied" };
}

/** Mirrors a transaction event; grants a credit pack on completion. */
async function applyTransaction(
	event: TransactionCompletedEvent | TransactionPaymentFailedEvent | TransactionUpdatedEvent,
	deps: ApplyDeps,
): Promise<ApplyResult> {
	const resolved = await resolveOrg(
		deps.store,
		{ transactionId: event.transactionId, subscriptionId: event.subscriptionId, customerId: event.customerId },
		event.organizationId,
	);
	if (resolved.orgId === null) {
		if (resolved.reason === "unrecorded_org" && event.subscriptionId) {
			// The subscription's own event may not have been applied yet; redelivery lets it land.
			throw new RetryableBillingEventError(
				`transaction ${event.transactionId}: subscription ${event.subscriptionId} is not on any row yet`,
			);
		}
		const worthAlerting =
			event.kind === "transaction_completed" ||
			resolved.reason === "mismatch" ||
			(resolved.reason === "unrecorded_org" && event.transaction.status === "billed");
		if (worthAlerting) {
			await deps.alert({
				title: "Paddle transaction for an unknown or different organization",
				subject: { type: "paddle_transaction", id: event.transactionId },
				summary:
					resolved.reason === "unrecorded_org"
						? `${describe(event)}: transaction ${event.transactionId} names an organization with no checkout order or Paddle customer of ours for it, so it was not recorded. If it is genuine, store the org's Paddle customer on its billing row; the transaction backfill then mirrors it.`
						: `${describe(event)}: transaction ${event.transactionId} was not recorded (${resolved.reason}).`,
			});
		}
		return { outcome: "refused", reason: resolved.reason };
	}
	const orgId = resolved.orgId;
	const applied = await deps.store.upsertTransaction({
		organizationId: orgId,
		transactionId: event.transactionId,
		subscriptionId: event.subscriptionId,
		customerId: event.customerId,
		occurredAt: event.occurredAt,
		snapshot: event.transaction,
	});
	if (event.kind === "transaction_payment_failed") {
		deps.warn("[paddle] payment failed", { event_id: event.eventId, transaction_id: event.transactionId, org_id: orgId });
	}
	if (event.kind === "transaction_completed" && event.item?.kind === "credit_pack") {
		await grantPack(event, orgId, deps);
	}
	return applied ? { outcome: "applied" } : { outcome: "refused", reason: "a newer event already wrote the mirror" };
}

/** Grants a completed credit pack, once, after checking it is a pack we sell. */
async function grantPack(event: TransactionCompletedEvent, orgId: string, deps: ApplyDeps): Promise<void> {
	const credits = event.item?.kind === "credit_pack" ? event.item.credits : 0;
	const userId = event.transaction.customData?.userId ?? null;
	const known = AI_CREDIT_PACKS.some((p) => p.credits === credits);
	if (!known || !userId) {
		await deps.alert({
			title: "Paddle credit-pack transaction not granted",
			subject: { type: "paddle_transaction", id: event.transactionId },
			summary: `${describe(event)}: org ${orgId} paid for a credit pack that names ${known ? "no user" : `an unknown size (${credits})`}; grant it by hand if it is genuine.`,
		});
		return;
	}
	await deps.store.grantPackCredits({ orgId, userId, credits, transactionId: event.transactionId });
}

/** Applies a refund / chargeback adjustment against a mirrored transaction. */
async function applyAdjustment(event: AdjustmentEvent, deps: ApplyDeps): Promise<ApplyResult> {
	if (event.status !== "approved" && event.status !== "reversed") {
		return { outcome: "ignored", reason: `adjustment ${event.status}` };
	}
	const txn = await deps.store.getTransaction(event.transactionId);
	if (!txn) {
		// Not mirrored yet (out of order), or never ours. Redelivery gives the transaction event time.
		throw new RetryableBillingEventError(`adjustment ${event.adjustmentId}: transaction not mirrored yet`);
	}
	const isPack = txn.customData?.kind === "credit_pack";
	const full = event.full ?? Math.abs(event.total.minor) >= Math.abs(txn.totalMinor);
	const subject: OperatorAlert["subject"] = { type: "paddle_transaction", id: event.transactionId };

	if (event.status === "reversed") {
		await deps.alert({
			title: "Paddle adjustment reversed",
			subject,
			summary: `${describe(event)}: ${event.action} ${event.adjustmentId} on org ${txn.organizationId} was reversed. Nothing was restored automatically.`,
		});
		return { outcome: "applied" };
	}

	switch (event.action) {
		case "refund": {
			if (!full) {
				await deps.alert({
					title: "Paddle partial refund",
					subject,
					summary: `${describe(event)}: a partial refund on org ${txn.organizationId}. ${isPack ? "Credit-pack credits were NOT reduced; adjust by hand." : "No entitlement changed."}`,
				});
				return { outcome: "applied" };
			}
			await deps.store.markTransaction(event.transactionId, { refundedAt: event.occurredAt });
			if (isPack) await deps.store.reversePackCredits(event.transactionId);
			return { outcome: "applied" };
		}
		case "chargeback": {
			await deps.store.markTransaction(event.transactionId, { chargebackAt: event.occurredAt });
			const reversed = isPack ? await deps.store.reversePackCredits(event.transactionId) : 0;
			await deps.alert({
				title: "Paddle chargeback",
				subject,
				summary: `${describe(event)}: chargeback on org ${txn.organizationId}${reversed > 0 ? `; ${reversed} pack credits reversed` : ""}. Review the account.`,
			});
			return { outcome: "applied" };
		}
		case "chargeback_reverse": {
			await deps.store.markTransaction(event.transactionId, { chargebackAt: null });
			await deps.alert({
				title: "Paddle chargeback reversed",
				subject,
				summary: `${describe(event)}: the chargeback on org ${txn.organizationId} was reversed in our favour. Credits are not restored automatically.`,
			});
			return { outcome: "applied" };
		}
		default:
			return { outcome: "ignored", reason: `adjustment action ${event.action}` };
	}
}

/**
 * Applies one normalized billing event under the rules in the header. Throws only for a database
 * failure or a {@link RetryableBillingEventError}; every deliberate refusal is a result, so the
 * caller acknowledges it (the provider must not redeliver what we chose not to apply).
 */
export async function applyBillingEvent(event: NormalizedBillingEvent, deps: ApplyDeps): Promise<ApplyResult> {
	if (event.provider !== "paddle") {
		return { outcome: "refused", reason: `${event.provider} events are applied by that provider's own handler` };
	}
	switch (event.kind) {
		case "subscription_upserted":
			return applyUpsert(event, deps);
		case "subscription_canceled":
			return applyCanceled(event, deps);
		case "transaction_completed":
		case "transaction_payment_failed":
		case "transaction_updated":
			return applyTransaction(event, deps);
		case "adjustment":
			return applyAdjustment(event, deps);
		case "ignored":
			return { outcome: "ignored", reason: event.reason };
	}
}
