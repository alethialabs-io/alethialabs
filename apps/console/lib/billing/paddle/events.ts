// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Paddle notification → provider-neutral billing event (lib/billing/provider/types.ts). Pure: the
// body has already passed the signature check (./signature.ts); this only parses and maps it.
//
// Every shape is a zod schema — no `as`, no `any`. Objects are `looseObject`, so a field Paddle adds
// later is carried, not refused; a field we READ that is missing or malformed fails the parse, and
// the route turns that into a 500 so Paddle redelivers once the parser is fixed (a 2xx would drop
// the event for good). An event type we do not act on is never parsed past its envelope.
//
// `custom_data` is UNTRUSTED. Checkout opens only server-created transactions, so in practice it is
// what our server wrote — but anyone with dashboard or API access to the Paddle account can write
// it too, and an org id in it decides nothing on its own: lib/billing/events/apply.ts prefers the org
// already holding the subscription, and otherwise needs a record of ours tying the org to the event. A custom_data that does not parse is
// dropped (null), never an error. What a subscription IS (plan or AI tier) comes from its price ids
// against the configured catalog, never from custom_data.

import { money } from "@repo/format";
import { z } from "zod";
import type { PaidAiTier, PaidPlan } from "@/lib/billing/config";
import type { PaddleConfig } from "@/lib/billing/paddle/config";
import type {
	AdjustmentEvent,
	NormalizedBillingEvent,
	PurchaseItem,
	SubscriptionSlot,
	TransactionSnapshot,
	TransactionUpdatedEvent,
} from "@/lib/billing/provider/types";
import type { BillingStatus } from "@/lib/db/schema/enums";
import { PADDLE_TRANSACTION_STATUSES } from "@/lib/db/schema/paddle-transaction";
import type { PaddleTransactionCustomData } from "@/types/jsonb.types";

/** A Paddle payload failed to parse where we read it. The route answers 500 (Paddle redelivers). */
export class PaddlePayloadError extends Error {
	/** Builds the error; `detail` names failing paths only — never values, which may be customer data. */
	constructor(what: string, detail: string) {
		super(`Paddle ${what} did not match the expected shape: ${detail}`);
		this.name = "PaddlePayloadError";
	}
}

/** An RFC 3339 timestamp, as Paddle sends it (microsecond precision, `Z`). */
const isoDate = z
	.string()
	.refine((s) => !Number.isNaN(Date.parse(s)), "must be an ISO 8601 timestamp")
	.transform((s) => new Date(s));

/** An amount in minor units, which Paddle sends as a decimal integer string (`"5900"`). */
const minorAmount = z
	.string()
	.regex(/^-?\d{1,15}$/, "must be an integer amount in minor units")
	.transform(Number);

const period = z.object({ starts_at: isoDate, ends_at: isoDate });

/** The notification envelope every Paddle event shares. */
export const paddleEnvelopeSchema = z.looseObject({
	event_id: z.string().min(1),
	event_type: z.string().min(1),
	occurred_at: isoDate,
	notification_id: z.string().optional(),
	data: z.unknown(),
});

export type PaddleEnvelope = z.infer<typeof paddleEnvelopeSchema>;

const subscriptionSchema = z.looseObject({
	id: z.string().startsWith("sub_"),
	status: z.enum(["active", "canceled", "past_due", "paused", "trialing"]),
	customer_id: z.string().nullish(),
	address_id: z.string().nullish(),
	business_id: z.string().nullish(),
	current_billing_period: period.nullish(),
	scheduled_change: z.looseObject({ action: z.string(), effective_at: isoDate }).nullish(),
	items: z.array(
		z.looseObject({
			quantity: z.number().int().nonnegative(),
			price: z.looseObject({ id: z.string() }),
		}),
	),
	custom_data: z.unknown().optional(),
	/** Only on `subscription.created`: the checkout transaction that created it. */
	transaction_id: z.string().nullish(),
});

const transactionSchema = z.looseObject({
	id: z.string().startsWith("txn_"),
	status: z.enum(PADDLE_TRANSACTION_STATUSES),
	customer_id: z.string().nullish(),
	subscription_id: z.string().nullish(),
	origin: z.string().nullish(),
	invoice_number: z.string().nullish(),
	currency_code: z.string().length(3),
	billed_at: isoDate.nullish(),
	billing_period: period.nullish(),
	custom_data: z.unknown().optional(),
	items: z
		.array(z.looseObject({ price: z.looseObject({ id: z.string() }).nullish() }))
		.optional(),
	details: z.looseObject({
		totals: z.looseObject({ subtotal: minorAmount, tax: minorAmount, total: minorAmount }),
	}),
});

const adjustmentSchema = z.looseObject({
	id: z.string().startsWith("adj_"),
	action: z.string(),
	type: z.enum(["full", "partial"]).nullish(),
	transaction_id: z.string().startsWith("txn_"),
	status: z.enum(["pending_approval", "approved", "rejected", "reversed"]),
	currency_code: z.string().length(3),
	totals: z.looseObject({ total: minorAmount }),
});

/** Our custom_data shape, validated. Mirrors `PaddleTransactionCustomData`. */
const customDataSchema = z.object({
	organizationId: z.uuid(),
	kind: z.enum(["plan", "ai_tier", "credit_pack", "usage_charge"]),
	plan: z.string().optional(),
	commerceOrderId: z.uuid().optional(),
	userId: z.uuid().optional(),
	credits: z.number().int().positive().optional(),
});

/** The subscription event types this adapter acts on. */
const SUBSCRIPTION_EVENTS: ReadonlySet<string> = new Set([
	"subscription.created",
	"subscription.updated",
	"subscription.activated",
	"subscription.trialing",
	"subscription.past_due",
	"subscription.paused",
	"subscription.resumed",
	"subscription.canceled",
]);

/**
 * The transaction event types that only move the mirror. `transaction.billed` is how a
 * manual-collection invoice (billed now, paid later) reaches the mirror before it is paid.
 */
const TRANSACTION_UPDATE_EVENTS: ReadonlySet<string> = new Set([
	"transaction.billed",
	"transaction.paid",
	"transaction.past_due",
]);

/** What a configured price id buys: a plan, or an AI tier. */
export type CatalogItem = { slot: "plan"; plan: PaidPlan } | { slot: "ai"; tier: PaidAiTier };

/** The configured price ids, as the normalizer reads them. */
export type PaddleCatalog = Pick<PaddleConfig, "prices">;

/** What a price id buys under `catalog`; null for a price we did not create. */
export function catalogItemForPrice(priceId: string, catalog: PaddleCatalog): CatalogItem | null {
	const { prices } = catalog;
	if (priceId === prices.team) return { slot: "plan", plan: "team" };
	if (prices.enterprise && priceId === prices.enterprise) return { slot: "plan", plan: "enterprise" };
	if (prices.aiPlus && priceId === prices.aiPlus) return { slot: "ai", tier: "ai_plus" };
	if (prices.aiMax && priceId === prices.aiMax) return { slot: "ai", tier: "ai_max" };
	return null;
}

/** Paddle's subscription status as a stored billing status. `paused` is not live and stores `none`. */
export function paddleStatusToBillingStatus(status: z.infer<typeof subscriptionSchema>["status"]): BillingStatus {
	switch (status) {
		case "active":
			return "active";
		case "trialing":
			return "trialing";
		case "past_due":
			return "past_due";
		case "canceled":
			return "canceled";
		case "paused":
			// The house convention (lib/billing/sync.ts `mapStatus`): a paused subscription grants
			// nothing and is stored as `none`; `subscription.resumed` brings it back to `active`.
			return "none";
	}
}

/** Parses custom_data; null when absent or not our shape (untrusted — never an error). */
export function parseCustomData(value: unknown): PaddleTransactionCustomData | null {
	const parsed = customDataSchema.safeParse(value);
	return parsed.success ? parsed.data : null;
}

/** Parses `data` against `schema` or throws {@link PaddlePayloadError}. */
function parseData<T extends z.ZodType>(schema: T, data: unknown, what: string): z.infer<T> {
	const parsed = schema.safeParse(data);
	if (!parsed.success) {
		const paths = parsed.error.issues.map((i) => i.path.map(String).join(".") || "(root)").join(", ");
		throw new PaddlePayloadError(what, `at ${paths}`);
	}
	return parsed.data;
}

/** Normalizes a subscription.* event. */
function normalizeSubscription(env: PaddleEnvelope, catalog: PaddleCatalog): NormalizedBillingEvent {
	const sub = parseData(subscriptionSchema, env.data, `${env.event_type} data`);
	const custom = parseCustomData(sub.custom_data);
	const base = {
		provider: "paddle" as const,
		eventId: env.event_id,
		eventType: env.event_type,
		occurredAt: env.occurred_at,
		organizationId: custom?.organizationId ?? null,
	};
	// The first item on a price we created decides the slot. A subscription is created from one of
	// our server-built transactions, which carry exactly one catalog price.
	let item: CatalogItem | null = null;
	let quantity: number | null = null;
	for (const line of sub.items) {
		const found = catalogItemForPrice(line.price.id, catalog);
		if (found) {
			item = found;
			quantity = line.quantity;
			break;
		}
	}
	if (!item) return { ...base, kind: "ignored", reason: `subscription ${sub.id} carries no configured price` };
	const slot: SubscriptionSlot = item.slot;

	if (sub.status === "canceled" || env.event_type === "subscription.canceled") {
		return { ...base, kind: "subscription_canceled", slot, subscriptionId: sub.id };
	}
	return {
		...base,
		kind: "subscription_upserted",
		slot,
		subscriptionId: sub.id,
		customerId: sub.customer_id ?? null,
		plan: item.slot === "plan" ? item.plan : null,
		aiTier: item.slot === "ai" ? item.tier : null,
		status: paddleStatusToBillingStatus(sub.status),
		seats: item.slot === "plan" ? quantity : null,
		currentPeriodStart: sub.current_billing_period?.starts_at ?? null,
		currentPeriodEnd: sub.current_billing_period?.ends_at ?? null,
		cancelEffectiveAt: sub.scheduled_change?.action === "cancel" ? sub.scheduled_change.effective_at : null,
		businessId: sub.business_id ?? null,
		addressId: sub.address_id ?? null,
		transactionId: sub.transaction_id ?? null,
	};
}

/** What a completed transaction bought: a credit pack from custom_data, else a catalog price. */
function purchasedItem(
	txn: z.infer<typeof transactionSchema>,
	custom: PaddleTransactionCustomData | null,
	catalog: PaddleCatalog,
): PurchaseItem | null {
	if (custom?.kind === "credit_pack") {
		return custom.credits ? { kind: "credit_pack", credits: custom.credits } : null;
	}
	for (const line of txn.items ?? []) {
		const found = line.price ? catalogItemForPrice(line.price.id, catalog) : null;
		if (found?.slot === "plan") return { kind: "plan", plan: found.plan };
		if (found?.slot === "ai") return { kind: "ai_tier", tier: found.tier };
	}
	return null;
}

/** The mirror's snapshot of a parsed transaction. */
function snapshotOf(txn: z.infer<typeof transactionSchema>, custom: PaddleTransactionCustomData | null): TransactionSnapshot {
	const { totals } = txn.details;
	return {
		status: txn.status,
		origin: txn.origin ?? null,
		subtotal: money(totals.subtotal, txn.currency_code),
		tax: money(totals.tax, txn.currency_code),
		total: money(totals.total, txn.currency_code),
		invoiceNumber: txn.invoice_number ?? null,
		billedAt: txn.billed_at ?? null,
		billingPeriodStart: txn.billing_period?.starts_at ?? null,
		billingPeriodEnd: txn.billing_period?.ends_at ?? null,
		customData: custom,
	};
}

/** Normalizes a transaction.* event we act on. */
function normalizeTransaction(env: PaddleEnvelope, catalog: PaddleCatalog): NormalizedBillingEvent {
	const txn = parseData(transactionSchema, env.data, `${env.event_type} data`);
	const custom = parseCustomData(txn.custom_data);
	const snapshot = snapshotOf(txn, custom);
	const common = {
		provider: "paddle" as const,
		eventId: env.event_id,
		eventType: env.event_type,
		occurredAt: env.occurred_at,
		organizationId: custom?.organizationId ?? null,
		transactionId: txn.id,
		subscriptionId: txn.subscription_id ?? null,
		customerId: txn.customer_id ?? null,
		transaction: snapshot,
	};
	if (env.event_type === "transaction.completed") {
		return {
			...common,
			kind: "transaction_completed",
			item: purchasedItem(txn, custom, catalog),
			total: snapshot.total,
			tax: snapshot.tax,
			billingPeriodStart: snapshot.billingPeriodStart,
			billingPeriodEnd: snapshot.billingPeriodEnd,
		};
	}
	if (env.event_type === "transaction.payment_failed") return { ...common, kind: "transaction_payment_failed" };
	return { ...common, kind: "transaction_updated" };
}

const readTransactionSchema = transactionSchema.extend({ updated_at: isoDate });

/** The event type a {@link transactionReadEvent} carries, so logs tell it from a webhook. */
export const TRANSACTION_READ_EVENT_TYPE = "transaction.read";

/**
 * A transaction as Paddle's API returns it (`GET /transactions`), as a mirror-only event — the
 * transaction backfill's input (lib/billing/events/backfill.ts). Its watermark is the transaction's
 * own `updated_at`, so it never overwrites a row a newer webhook wrote, and any later webhook wins
 * over it. Mirror-only on purpose: a completed credit pack read here grants nothing (a pack that was
 * never granted was alerted when its webhook was refused, and may since have been granted by hand).
 * Throws {@link PaddlePayloadError} when the transaction does not carry what the mirror reads.
 */
export function transactionReadEvent(data: unknown): TransactionUpdatedEvent {
	const txn = parseData(readTransactionSchema, data, "transaction");
	const custom = parseCustomData(txn.custom_data);
	return {
		provider: "paddle",
		eventId: `read:${txn.id}:${txn.updated_at.toISOString()}`,
		eventType: TRANSACTION_READ_EVENT_TYPE,
		occurredAt: txn.updated_at,
		organizationId: custom?.organizationId ?? null,
		kind: "transaction_updated",
		transactionId: txn.id,
		subscriptionId: txn.subscription_id ?? null,
		customerId: txn.customer_id ?? null,
		transaction: snapshotOf(txn, custom),
	};
}

/** Paddle's adjustment action, folded onto the seam's closed list. */
function adjustmentAction(action: string): AdjustmentEvent["action"] {
	switch (action) {
		case "refund":
		case "chargeback":
		case "chargeback_reverse":
		case "credit":
			return action;
		default:
			return "other";
	}
}

/** Normalizes an adjustment.* event. */
function normalizeAdjustment(env: PaddleEnvelope): NormalizedBillingEvent {
	const adj = parseData(adjustmentSchema, env.data, `${env.event_type} data`);
	return {
		provider: "paddle",
		eventId: env.event_id,
		eventType: env.event_type,
		occurredAt: env.occurred_at,
		organizationId: null,
		kind: "adjustment",
		adjustmentId: adj.id,
		transactionId: adj.transaction_id,
		action: adjustmentAction(adj.action),
		status: adj.status,
		total: money(adj.totals.total, adj.currency_code),
		full: adj.type == null ? null : adj.type === "full",
	};
}

/** Parses the raw (already verified) body's envelope. Throws {@link PaddlePayloadError}. */
export function parsePaddleEnvelope(rawBody: string): PaddleEnvelope {
	let json: unknown;
	try {
		json = JSON.parse(rawBody);
	} catch {
		throw new PaddlePayloadError("notification", "not JSON");
	}
	return parseData(paddleEnvelopeSchema, json, "notification");
}

/**
 * Maps one Paddle notification onto the provider-neutral event. An event type we do not act on is
 * `ignored` (acknowledged, recorded in the ledger, nothing else). Throws {@link PaddlePayloadError}
 * when an event we act on does not carry what we read.
 */
export function normalizePaddleEvent(env: PaddleEnvelope, catalog: PaddleCatalog): NormalizedBillingEvent {
	if (SUBSCRIPTION_EVENTS.has(env.event_type)) return normalizeSubscription(env, catalog);
	if (
		env.event_type === "transaction.completed" ||
		env.event_type === "transaction.payment_failed" ||
		TRANSACTION_UPDATE_EVENTS.has(env.event_type)
	) {
		return normalizeTransaction(env, catalog);
	}
	if (env.event_type === "adjustment.created" || env.event_type === "adjustment.updated") {
		return normalizeAdjustment(env);
	}
	return {
		provider: "paddle",
		eventId: env.event_id,
		eventType: env.event_type,
		occurredAt: env.occurred_at,
		organizationId: null,
		kind: "ignored",
		reason: "event type not handled",
	};
}
