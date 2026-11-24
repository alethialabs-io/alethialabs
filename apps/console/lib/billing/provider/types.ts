// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The billing-provider seam: the one interface every payment provider (Stripe, Paddle) is driven
// through, and the provider-neutral event shape their webhooks are normalized into. Types only — the
// adapters arrive in later lanes (Paddle: L3/L4; Stripe: a thin wrapper over today's billing.ts), and
// selection lives in ./select.ts.
//
// Two facts decide which provider a call goes to, and they are deliberately different:
//   · a NEW sale follows the instance's sales provider (`BILLING_PROVIDER`, fails closed);
//   · an EXISTING subscription follows the org's own row (`organization_billing.billing_provider`),
//     so flipping `BILLING_PROVIDER` never strands a customer whose subscription lives elsewhere.

import type { Money } from "@repo/format";
import type { PaidAiTier, PaidPlan } from "@/lib/billing/config";
import type { SupportedCurrency } from "@repo/plan-catalog";
import type { BillingProviderId } from "@/lib/db/schema/billing-provider";
import type { BillingStatus } from "@/lib/db/schema/enums";

export type { BillingProviderId } from "@/lib/db/schema/billing-provider";

/**
 * Who sells to the customer in law. `alethia` = we are the seller (Stripe as our processor: our
 * invoices, our VAT, our market thresholds); `paddle` = Paddle is the merchant of record and resells
 * to the customer (Paddle's invoice and tax; our eligibility skips the seller-side thresholds).
 */
export type SellerOfRecord = "alethia" | "paddle";

/** Whether a configured provider moves real money. Decided by the KEY, never by a separate flag. */
export type ProviderMode = "test" | "live";

/** Which subscription slot on the billing row a subscription fills. */
export type SubscriptionSlot = "plan" | "ai";

/** Something a customer can buy self-serve. */
export type PurchaseItem =
	| { kind: "plan"; plan: PaidPlan; seats?: number }
	| { kind: "ai_tier"; tier: PaidAiTier }
	| { kind: "credit_pack"; credits: number };

/** A request to start a purchase for an org. Built server-side; nothing here comes from the client. */
export interface PurchaseRequest {
	organizationId: string;
	userId: string;
	item: PurchaseItem;
	/** The `commerce_order` row recorded for this purchase, when one was placed first. */
	commerceOrderId?: string;
	/** A currency preference; a provider that localises by country may ignore it. */
	currency?: SupportedCurrency;
	/** Absolute URL to return to when the checkout completes or is abandoned. */
	returnUrl: string;
}

/**
 * How the client continues a purchase the server started. Paddle always opens a SERVER-CREATED
 * transaction by id in Paddle.js (so custom_data and prices cannot be tampered with client-side);
 * Stripe hands back a hosted-checkout URL or an embedded-element client secret.
 */
export type PurchaseStart =
	| { kind: "paddle_checkout"; transactionId: string; clientToken: string; environment: "sandbox" | "live" }
	| { kind: "redirect"; url: string }
	| { kind: "client_secret"; clientSecret: string };

/** Names one provider subscription on an org. */
export interface SubscriptionRef {
	organizationId: string;
	subscriptionId: string;
	slot: SubscriptionSlot;
}

/** One overage charge to post against a subscription (the `usage_charge` ledger row's facts). */
export interface UsageChargeRequest {
	/** The claimed `usage_charge` row — the idempotency, since a provider may have no key of its own. */
	usageChargeId: string;
	organizationId: string;
	subscriptionId: string;
	periodStart: Date;
	periodEnd: Date;
	overageMinutes: number;
	amount: Money;
	/** Bill now (final cancellation) instead of riding the next renewal. */
	immediate?: boolean;
}

/** The provider's answer to a posted usage charge. */
export interface UsageChargePosted {
	/** The provider's reference for it, when it returns one (Paddle: the next transaction's id). */
	providerRef: string | null;
}

/** Job-minutes to meter for an org, for a provider whose prices are metered (Stripe). */
export interface JobUsageReport {
	organizationId: string;
	customerId: string | null;
	minutes: number;
	/** Stable id for the metered unit (the job run), so a resend is deduplicated provider-side. */
	idempotencyKey: string;
}

/** A customer-facing billing document (an invoice, a receipt, a credit note) for the billing page. */
export interface BillingDocument {
	id: string;
	kind: "invoice" | "credit_note" | "receipt";
	number: string | null;
	issuedAt: Date | null;
	total: Money;
	/** Where the customer can open/download it, when the provider hosts it. */
	url: string | null;
	/** Who issued it — Paddle's documents are Paddle's, not ours. */
	issuer: SellerOfRecord;
}

/** A provider's live self-serve prices, per item, per currency. */
export interface LivePriceList {
	plans: { readonly [P in PaidPlan]?: { readonly [C in SupportedCurrency]?: Money } };
	aiTiers: { readonly [T in PaidAiTier]?: { readonly [C in SupportedCurrency]?: Money } };
}

/** A webhook delivery as the route received it: the raw body (for the signature) and its headers. */
export interface WebhookDelivery {
	rawBody: string;
	headers: Headers;
}

// ── Normalized events ──────────────────────────────────────────────────────────────────────────

/** What every normalized event carries: whose event it is, its id/type, and when it happened. */
interface NormalizedEventBase {
	provider: BillingProviderId;
	/** The provider's event id — the exactly-once ledger key, with `provider`. */
	eventId: string;
	/** The provider's own event type, kept for logs and the ledger. */
	eventType: string;
	/** When the provider says it happened — the out-of-order watermark. */
	occurredAt: Date;
	/** The org it belongs to, when the event names one (custom_data / a known customer). */
	organizationId: string | null;
}

/** A subscription was created or changed (status, plan, period, scheduled cancellation). */
export interface SubscriptionUpsertedEvent extends NormalizedEventBase {
	kind: "subscription_upserted";
	slot: SubscriptionSlot;
	subscriptionId: string;
	customerId: string | null;
	/** The plan, for a `plan` slot. */
	plan: PaidPlan | null;
	/** The AI tier, for an `ai` slot. */
	aiTier: PaidAiTier | null;
	status: BillingStatus;
	seats: number | null;
	currentPeriodStart: Date | null;
	currentPeriodEnd: Date | null;
	/** When a scheduled cancellation takes effect; null when none is scheduled. */
	cancelEffectiveAt: Date | null;
}

/** A subscription ended for good. */
export interface SubscriptionCanceledEvent extends NormalizedEventBase {
	kind: "subscription_canceled";
	slot: SubscriptionSlot;
	subscriptionId: string;
}

/** Money was collected: a checkout, a renewal, a usage charge, a credit pack. */
export interface TransactionCompletedEvent extends NormalizedEventBase {
	kind: "transaction_completed";
	transactionId: string;
	subscriptionId: string | null;
	customerId: string | null;
	/** What was bought, when the transaction was one we created (custom_data). */
	item: PurchaseItem | null;
	total: Money;
	tax: Money;
	billingPeriodStart: Date | null;
	billingPeriodEnd: Date | null;
}

/** A collection attempt failed (dunning). */
export interface TransactionPaymentFailedEvent extends NormalizedEventBase {
	kind: "transaction_payment_failed";
	transactionId: string;
	subscriptionId: string | null;
}

/** A refund or chargeback against a transaction changed state. */
export interface AdjustmentEvent extends NormalizedEventBase {
	kind: "adjustment";
	adjustmentId: string;
	transactionId: string;
	action: "refund" | "chargeback" | "chargeback_reverse" | "credit" | "other";
	status: "pending_approval" | "approved" | "rejected" | "reversed";
	total: Money;
}

/** An event the seam does not act on — acknowledged and recorded, nothing else. */
export interface IgnoredEvent extends NormalizedEventBase {
	kind: "ignored";
}

/** Every provider's webhook, as the provider-neutral `applyBillingEvent` (L3) consumes it. */
export type NormalizedBillingEvent =
	| SubscriptionUpsertedEvent
	| SubscriptionCanceledEvent
	| TransactionCompletedEvent
	| TransactionPaymentFailedEvent
	| AdjustmentEvent
	| IgnoredEvent;

// ── The provider interface ─────────────────────────────────────────────────────────────────────

/** One payment provider, driven through the seam. Every method is server-only. */
export interface BillingProvider {
	readonly id: BillingProviderId;
	readonly sellerOfRecord: SellerOfRecord;
	/** Whether this instance has the provider's credentials at all. */
	isConfigured(): boolean;
	/** Test or live, from the configured key; null when not configured. */
	mode(): ProviderMode | null;
	/** Starts a self-serve purchase and says how the client continues it. */
	startPurchase(req: PurchaseRequest): Promise<PurchaseStart>;
	/** A URL where the org's billing contact manages payment methods / subscriptions; null if none. */
	managementUrl(organizationId: string, returnUrl: string): Promise<string | null>;
	/** Schedules the subscription to end at its current period's end. */
	cancelAtPeriodEnd(ref: SubscriptionRef): Promise<void>;
	/** Withdraws a scheduled cancellation. */
	resume(ref: SubscriptionRef): Promise<void>;
	/** Moves the subscription to another plan / tier / seat count. */
	changePlan(ref: SubscriptionRef, item: PurchaseItem): Promise<void>;
	/** Posts one overage charge (claimed in `usage_charge` before this is called). */
	postUsageCharge(charge: UsageChargeRequest): Promise<UsageChargePosted>;
	/** Meters job-minutes where the provider bills them (Stripe meters); false when it does not. */
	reportJobUsage(usage: JobUsageReport): Promise<boolean>;
	/** The org's billing documents, newest first. */
	listDocuments(organizationId: string, opts?: { limit?: number }): Promise<BillingDocument[]>;
	/** The provider's live self-serve prices. */
	livePrices(): Promise<LivePriceList>;
	/** Verifies a webhook delivery's signature and normalizes it. Throws on a bad signature. */
	parseWebhook(delivery: WebhookDelivery): Promise<NormalizedBillingEvent[]>;
}
