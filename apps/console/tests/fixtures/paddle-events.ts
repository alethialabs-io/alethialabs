// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Paddle notification payloads for the Paddle webhook tests, shaped after Paddle Billing's documented
// `subscription.*`, `transaction.*` and `adjustment.*` notifications (only the fields we read plus a
// few we ignore, to prove unknown fields are carried). Builders, not snapshots: each test states the
// one field it is about.

import type { PaddleCatalog } from "@/lib/billing/paddle/events";

export const PRICE_TEAM = "pri_01teamtest";
export const PRICE_ENTERPRISE = "pri_01enttest";
export const PRICE_AI_PLUS = "pri_01aiplustest";
export const PRICE_AI_MAX = "pri_01aimaxtest";

/** The catalog the fixtures' price ids belong to. */
export const CATALOG: PaddleCatalog = {
	prices: { team: PRICE_TEAM, enterprise: PRICE_ENTERPRISE, aiPlus: PRICE_AI_PLUS, aiMax: PRICE_AI_MAX },
};

type Json = Record<string, unknown>;

/** A notification envelope around `data`. */
export function envelope(eventType: string, data: Json, over: Json = {}): Json {
	return {
		event_id: "evt_01test",
		event_type: eventType,
		occurred_at: "2026-11-25T10:00:00.123456Z",
		notification_id: "ntf_01test",
		data,
		...over,
	};
}

/** A subscription entity. */
export function subscriptionData(over: Json = {}): Json {
	return {
		id: "sub_01test",
		status: "active",
		customer_id: "ctm_01test",
		address_id: "add_01test",
		business_id: "biz_01test",
		currency_code: "EUR",
		collection_mode: "automatic",
		current_billing_period: { starts_at: "2026-11-25T00:00:00Z", ends_at: "2026-12-25T00:00:00Z" },
		billing_cycle: { interval: "month", frequency: 1 },
		scheduled_change: null,
		items: [{ status: "active", quantity: 3, price: { id: PRICE_TEAM, product_id: "pro_01test" } }],
		custom_data: null,
		management_urls: { update_payment_method: "https://example.invalid/u", cancel: "https://example.invalid/c" },
		...over,
	};
}

/** A transaction entity with totals in minor units (as strings, as Paddle sends them). */
export function transactionData(over: Json = {}): Json {
	return {
		id: "txn_01test",
		status: "completed",
		customer_id: "ctm_01test",
		subscription_id: "sub_01test",
		origin: "web",
		invoice_number: "325-10566",
		currency_code: "EUR",
		billed_at: "2026-11-25T10:00:00Z",
		billing_period: { starts_at: "2026-11-25T00:00:00Z", ends_at: "2026-12-25T00:00:00Z" },
		custom_data: null,
		items: [{ quantity: 1, price: { id: PRICE_TEAM } }],
		details: { totals: { subtotal: "5900", tax: "1180", total: "7080", grand_total: "7080", currency_code: "EUR" } },
		...over,
	};
}

/** An adjustment entity. */
export function adjustmentData(over: Json = {}): Json {
	return {
		id: "adj_01test",
		action: "refund",
		type: "full",
		transaction_id: "txn_01test",
		subscription_id: null,
		customer_id: "ctm_01test",
		reason: "requested_by_customer",
		currency_code: "EUR",
		status: "approved",
		totals: { subtotal: "5900", tax: "1180", total: "7080", fee: "0", earnings: "0", currency_code: "EUR" },
		...over,
	};
}
