// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Runner-minute overage for Paddle subscriptions (L5). Paddle has no metered price, so the METER
// is ours: the `jobs` table (managed-runner job-minutes, `queryJobMinutesByOrg`), against the plan's
// included minutes, through the same `computeUsage` the Usage page shows. What is over the allowance
// is priced from @repo/plan-catalog (`runnerOverageAmountMinor`) in the subscription's currency and
// posted as ONE non-catalog one-time charge per billing period (./overage-sweeper.ts decides when).
//
// This file holds the parts that do not touch our database:
//   · `measureOverage` — used vs included → whole overage minutes and the amount (pure);
//   · the three Paddle calls the sweeper makes: read the subscription, post the charge, and FIND a
//     charge already posted. Paddle has no idempotency key and the charge endpoint returns the
//     subscription, not the charge, so the only way to know whether an earlier attempt landed is to
//     look: the subscription's `next_transaction` preview (a `next_billing_period` charge) and its
//     recent transactions (an `immediately` charge, or one that has since been billed). Each charge
//     carries the `usage_charge` row id in its price's `custom_data`, so a found charge is OURS for
//     THAT row, never just "a runner-minutes line";
//   · `recordPaddleJobUsage` — the seam's `reportJobUsage` for Paddle (there is no provider meter).
//
// Every response goes through a zod schema (no `as`); a Paddle error is a `PaddleApiError` whose
// `outcomeUnknown` tells the caller whether a retry must reconcile first.

import { type Money, money } from "@repo/format";
import { asSupportedCurrency, runnerOverageAmountMinor, type SupportedCurrency } from "@repo/plan-catalog";
import { z } from "zod";
import { PaddleApiError, type PaddleClient } from "@/lib/billing/paddle/api";
import type { JobUsageReport, UsageChargePosted, UsageChargeRequest } from "@/lib/billing/provider/types";
import { computeUsage } from "@/lib/billing/usage";

/**
 * O9: at a FINAL cancellation the overage is charged immediately only when it is at least this
 * much (€5, and the same number of minor units in USD); below it is waived.
 */
export const OVERAGE_IMMEDIATE_MINIMUM_MINOR = 500;

/** The `custom_data.kind` a usage charge's price carries (matches `PaddleTransactionCustomData`). */
export const USAGE_CHARGE_KIND = "usage_charge";

/** What a period's usage comes to. */
export interface OverageMeasurement {
	/** Whole minutes over the allowance (a partial minute is not charged). */
	overageMinutes: number;
	/** What those minutes cost in the subscription's currency, in whole minor units. */
	amount: Money;
}

/**
 * Used vs included runner minutes → the whole overage minutes and their price in `currency`.
 * The overage is `computeUsage`'s (the Usage page's own number), floored to whole minutes; the
 * amount is the catalog rate, rounded down to a whole minor unit.
 */
export function measureOverage(
	usedMinutes: number,
	includedMinutes: number,
	currency: SupportedCurrency,
): OverageMeasurement {
	const overageMinutes = Math.floor(computeUsage(usedMinutes, includedMinutes).overageMinutes);
	return { overageMinutes, amount: money(runnerOverageAmountMinor(overageMinutes, currency), currency) };
}

/**
 * The seam's `reportJobUsage` for Paddle: nothing is sent anywhere. The `jobs` row (its start and
 * completion) IS the ledger the overage is computed from, so the job is recorded as soon as it
 * finished; true when it carries minutes to bill.
 */
export function recordPaddleJobUsage(usage: JobUsageReport): Promise<boolean> {
	return Promise.resolve(usage.minutes > 0);
}

// ── Paddle shapes ──────────────────────────────────────────────────────────────────────────────

const isoDate = z
	.string()
	.refine((s) => !Number.isNaN(Date.parse(s)), "must be an ISO 8601 timestamp")
	.transform((s) => new Date(s));

/** The usage-charge marker on a price's `custom_data`; anything else is not ours. */
const usageChargeMarker = z.looseObject({ kind: z.literal(USAGE_CHARGE_KIND), usageChargeId: z.string() });

/** The usage-charge row id a price's `custom_data` names, or null when it is not one of ours. */
function markerOf(customData: unknown): string | null {
	const parsed = usageChargeMarker.safeParse(customData);
	return parsed.success ? parsed.data.usageChargeId : null;
}

/** The subscription fields the sweeper reads (`GET /subscriptions/{id}?include=next_transaction`). */
export const chargeableSubscriptionSchema = z.looseObject({
	id: z.string().startsWith("sub_"),
	// Paddle's status as given. Only `active` (charge) and `past_due` (wait, then page) are acted on,
	// so it is not narrowed to a list here: the one list of Paddle statuses lives in ./events.ts.
	status: z.string(),
	currency_code: z.string().length(3),
	current_billing_period: z.object({ starts_at: isoDate, ends_at: isoDate }).nullish(),
	scheduled_change: z.looseObject({ action: z.string(), effective_at: isoDate }).nullish(),
	next_transaction: z
		.looseObject({
			details: z.looseObject({
				line_items: z.array(
					z.looseObject({
						price_id: z.string().nullish(),
						product: z.looseObject({ id: z.string() }).nullish(),
					}),
				),
			}),
		})
		.nullish(),
});

export type ChargeableSubscription = z.infer<typeof chargeableSubscriptionSchema>;

/** A transaction's items, as far as finding a charge needs (`GET /transactions`). */
const chargeTransactionSchema = z.looseObject({
	id: z.string().startsWith("txn_"),
	items: z.array(z.looseObject({ price: z.looseObject({ custom_data: z.unknown().optional() }).nullish() })),
});

const priceSchema = z.looseObject({ id: z.string(), custom_data: z.unknown().optional() });

/** The currency a subscription bills in, when it is one we price overage in. */
export function subscriptionCurrency(sub: ChargeableSubscription): SupportedCurrency | null {
	return asSupportedCurrency(sub.currency_code.toLowerCase());
}

/** Whether the subscription is scheduled to end — its overage is then the FINAL one (O9). */
export function isFinalPeriod(sub: ChargeableSubscription): boolean {
	return sub.scheduled_change?.action === "cancel";
}

// ── Paddle calls ───────────────────────────────────────────────────────────────────────────────

/** Reads a subscription with its next-transaction preview. Read-only. */
export function getChargeableSubscription(client: PaddleClient, subscriptionId: string): Promise<ChargeableSubscription> {
	return client.request(
		{
			method: "GET",
			path: `/subscriptions/${encodeURIComponent(subscriptionId)}`,
			query: { include: "next_transaction" },
		},
		chargeableSubscriptionSchema,
	);
}

/** The JSON body of one overage charge (exported for tests). */
export function usageChargeBody(charge: UsageChargeRequest, productId: string) {
	const minutes = charge.overageMinutes;
	return {
		effective_from: charge.immediate ? "immediately" : "next_billing_period",
		items: [
			{
				quantity: 1,
				price: {
					product_id: productId,
					name: `${minutes} overage runner minutes`.slice(0, 50),
					description: `Managed runner minutes over the plan allowance, ${charge.periodStart.toISOString().slice(0, 10)} to ${charge.periodEnd.toISOString().slice(0, 10)} (usage charge ${charge.usageChargeId})`,
					tax_mode: "account_setting",
					unit_price: { amount: String(charge.amount.minor), currency_code: charge.amount.currency.toUpperCase() },
					custom_data: {
						organizationId: charge.organizationId,
						kind: USAGE_CHARGE_KIND,
						usageChargeId: charge.usageChargeId,
					},
				},
			},
		],
	};
}

/**
 * Posts ONE non-catalog one-time charge (`POST /subscriptions/{id}/charge`): on the next renewal by
 * default (one fee, one invoice), or immediately for a final cancellation. The response is the
 * subscription — the charge itself is not in it — so `providerRef` is null; the sweeper finds it
 * afterwards with {@link findPostedCharge}. Throws `PaddleApiError`; a non-positive amount is
 * refused here rather than sent.
 */
export async function postPaddleUsageCharge(
	client: PaddleClient,
	productId: string | undefined,
	charge: UsageChargeRequest,
): Promise<UsageChargePosted> {
	if (!productId) {
		throw new Error("PADDLE_PRODUCT_RUNNER_MINUTES is not set: the overage charge has no product to reference");
	}
	if (!(charge.amount.minor > 0) || !Number.isInteger(charge.amount.minor)) {
		throw new Error(`usage charge ${charge.usageChargeId}: amount must be a positive whole number of minor units`);
	}
	await client.request(
		{
			method: "POST",
			path: `/subscriptions/${encodeURIComponent(charge.subscriptionId)}/charge`,
			body: usageChargeBody(charge, productId),
		},
		z.looseObject({ id: z.string() }),
	);
	return { providerRef: null };
}

/** Where a posted charge was found: the price on the next renewal, or a transaction already made. */
export interface FoundCharge {
	/** `pri_…` when it waits on the next renewal; `txn_…` when a transaction carries it. */
	providerRef: string;
}

/** How many recent transactions of the subscription are searched for an already-billed charge. */
const RECENT_TRANSACTIONS = 30;

/**
 * Looks for the charge a `usage_charge` row posted. Checks the next renewal's preview (each
 * runner-minutes line's price is read for its `custom_data`) and the subscription's most recent
 * transactions. Null only when BOTH say it is not there; any Paddle error throws, so a caller
 * never re-posts on a lookup that did not complete.
 */
export async function findPostedCharge(
	client: PaddleClient,
	subscriptionId: string,
	usageChargeId: string,
	productId: string | undefined,
): Promise<FoundCharge | null> {
	const sub = await getChargeableSubscription(client, subscriptionId);
	for (const line of sub.next_transaction?.details.line_items ?? []) {
		if (!line.price_id) continue;
		if (productId && line.product?.id !== productId) continue;
		const price = await client.request(
			{ method: "GET", path: `/prices/${encodeURIComponent(line.price_id)}` },
			priceSchema,
		);
		if (markerOf(price.custom_data) === usageChargeId) return { providerRef: price.id };
	}

	const txns = await client.request(
		{
			method: "GET",
			path: "/transactions",
			query: { subscription_id: subscriptionId, order_by: "created_at[DESC]", per_page: RECENT_TRANSACTIONS },
		},
		z.array(chargeTransactionSchema),
	);
	for (const txn of txns) {
		if (txn.items.some((item) => markerOf(item.price?.custom_data) === usageChargeId)) {
			return { providerRef: txn.id };
		}
	}
	return null;
}

/**
 * Whether a failed charge call was REFUSED (the charge certainly does not exist): a 4xx other than
 * timeout / conflict / rate limit. Everything else — a timeout, a network failure, a 5xx, a 2xx we
 * could not parse — leaves the outcome unknown, and the row stays claimed for reconciliation.
 */
export function isDefiniteRefusal(err: unknown): boolean {
	if (!(err instanceof PaddleApiError) || err.kind !== "http" || err.status === null) return false;
	if (err.status === 408 || err.status === 409 || err.status === 429) return false;
	return err.status >= 400 && err.status < 500;
}
