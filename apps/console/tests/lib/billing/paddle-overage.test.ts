// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Paddle overage (lib/billing/paddle/overage.ts): the measurement under / at / over the allowance,
// the charge body Paddle receives, and the lookup that decides whether an earlier attempt landed —
// matched on the usage-charge row id the charge carries, never on "a runner-minutes line exists".
// A routing fetch stub stands in for Paddle; nothing touches the network.

import { money } from "@repo/format";
import { describe, expect, it, vi } from "vitest";
import { createPaddleClient, PaddleApiError } from "@/lib/billing/paddle/api";
import {
	chargeableSubscriptionSchema,
	findPostedCharge,
	isDefiniteRefusal,
	isFinalPeriod,
	measureOverage,
	postPaddleUsageCharge,
	recordPaddleJobUsage,
	subscriptionCurrency,
	usageChargeBody,
} from "@/lib/billing/paddle/overage";
import type { UsageChargeRequest } from "@/lib/billing/provider/types";

const KEY = `pdl_sdbx_apikey_${"c".repeat(20)}`;
const PRODUCT = "pro_runnerminutes";

/** A fetch stub answering by `METHOD path` (query ignored), recording every call. */
function routes(table: Record<string, unknown>) {
	return vi.fn<typeof fetch>(async (input, init) => {
		const url = new URL(String(input));
		const key = `${init?.method ?? "GET"} ${url.pathname}`;
		if (!(key in table)) return new Response(JSON.stringify({ error: { code: "not_found" } }), { status: 404 });
		return new Response(JSON.stringify({ data: table[key] }), { status: 200 });
	});
}

/** A client over a stub. */
function client(f: typeof fetch) {
	return createPaddleClient({ apiKey: KEY, environment: "sandbox", fetch: f });
}

/** A subscription as Paddle returns it, with optional next-transaction lines. */
function sub(over: Record<string, unknown> = {}) {
	return {
		id: "sub_1",
		status: "active",
		currency_code: "EUR",
		current_billing_period: { starts_at: "2026-11-01T00:00:00Z", ends_at: "2026-12-01T00:00:00Z" },
		scheduled_change: null,
		next_transaction: { details: { line_items: [] } },
		...over,
	};
}

const charge: UsageChargeRequest = {
	usageChargeId: "uc-1",
	organizationId: "org-1",
	subscriptionId: "sub_1",
	periodStart: new Date("2026-11-01T00:00:00Z"),
	periodEnd: new Date("2026-12-01T00:00:00Z"),
	overageMinutes: 250,
	amount: money(275, "eur"),
};

describe("measureOverage", () => {
	it("is nothing under the allowance and nothing exactly at it", () => {
		expect(measureOverage(499.9, 500, "eur")).toEqual({ overageMinutes: 0, amount: money(0, "eur") });
		expect(measureOverage(500, 500, "eur")).toEqual({ overageMinutes: 0, amount: money(0, "eur") });
	});

	it("over the allowance charges whole minutes at the catalog rate for the currency", () => {
		expect(measureOverage(750.9, 500, "eur")).toEqual({ overageMinutes: 250, amount: money(275, "eur") });
		expect(measureOverage(750.9, 500, "usd")).toEqual({ overageMinutes: 250, amount: money(300, "usd") });
	});

	it("treats a zero allowance as everything over", () => {
		expect(measureOverage(10, 0, "usd").overageMinutes).toBe(10);
	});
});

describe("recordPaddleJobUsage", () => {
	it("is true only for a job with minutes", async () => {
		await expect(recordPaddleJobUsage({ organizationId: "o", customerId: null, minutes: 3, idempotencyKey: "j" })).resolves.toBe(true);
		await expect(recordPaddleJobUsage({ organizationId: "o", customerId: null, minutes: 0, idempotencyKey: "j" })).resolves.toBe(false);
	});
});

describe("subscription facts", () => {
	it("reads the currency and whether this is the final period", () => {
		const parse = (over: Record<string, unknown>) => chargeableSubscriptionSchema.parse(sub(over));
		expect(subscriptionCurrency(parse({}))).toBe("eur");
		expect(subscriptionCurrency(parse({ currency_code: "GBP" }))).toBeNull();
		expect(isFinalPeriod(parse({ scheduled_change: { action: "cancel", effective_at: "2026-12-01T00:00:00Z" } }))).toBe(true);
		expect(isFinalPeriod(parse({ scheduled_change: { action: "pause", effective_at: "2026-12-01T00:00:00Z" } }))).toBe(false);
		expect(isFinalPeriod(parse({}))).toBe(false);
	});
});

describe("usageChargeBody / postPaddleUsageCharge", () => {
	it("rides the next renewal by default, with the row id in the price's custom_data", () => {
		const body = usageChargeBody(charge, PRODUCT);
		expect(body.effective_from).toBe("next_billing_period");
		expect(body.items).toHaveLength(1);
		expect(body.items[0].price).toMatchObject({
			product_id: PRODUCT,
			unit_price: { amount: "275", currency_code: "EUR" },
			custom_data: { organizationId: "org-1", kind: "usage_charge", usageChargeId: "uc-1" },
		});
		expect(body.items[0].price.name.length).toBeLessThanOrEqual(50);
	});

	it("charges immediately for a final cancellation", () => {
		expect(usageChargeBody({ ...charge, immediate: true }, PRODUCT).effective_from).toBe("immediately");
	});

	it("posts one charge to the subscription and returns no provider ref", async () => {
		const f = routes({ "POST /subscriptions/sub_1/charge": sub() });
		await expect(postPaddleUsageCharge(client(f), PRODUCT, charge)).resolves.toEqual({ providerRef: null });
		expect(f).toHaveBeenCalledTimes(1);
		expect(JSON.parse(String(f.mock.calls[0][1]?.body))).toEqual(usageChargeBody(charge, PRODUCT));
	});

	it("refuses to send without a product, or with a zero or fractional amount", async () => {
		const f = routes({});
		await expect(postPaddleUsageCharge(client(f), undefined, charge)).rejects.toThrow(/PADDLE_PRODUCT_RUNNER_MINUTES/);
		await expect(postPaddleUsageCharge(client(f), PRODUCT, { ...charge, amount: money(0, "eur") })).rejects.toThrow(/positive/);
		await expect(postPaddleUsageCharge(client(f), PRODUCT, { ...charge, amount: money(1.5, "eur") })).rejects.toThrow(/positive/);
		expect(f).not.toHaveBeenCalled();
	});
});

describe("findPostedCharge (reconcile before any re-post)", () => {
	it("finds a charge waiting on the next renewal by its price's custom_data", async () => {
		const f = routes({
			"GET /subscriptions/sub_1": sub({
				next_transaction: {
					details: {
						line_items: [
							{ price_id: "pri_plan", product: { id: "pro_plan" } },
							{ price_id: "pri_other", product: { id: PRODUCT } },
							{ price_id: "pri_ours", product: { id: PRODUCT } },
						],
					},
				},
			}),
			"GET /prices/pri_other": { id: "pri_other", custom_data: { kind: "usage_charge", usageChargeId: "uc-OTHER" } },
			"GET /prices/pri_ours": { id: "pri_ours", custom_data: { kind: "usage_charge", usageChargeId: "uc-1" } },
		});
		await expect(findPostedCharge(client(f), "sub_1", "uc-1", PRODUCT)).resolves.toEqual({ providerRef: "pri_ours" });
		// The plan line is never read: it is not the runner-minutes product.
		expect(f.mock.calls.some(([u]) => String(u).includes("pri_plan"))).toBe(false);
	});

	it("finds a charge already billed on a transaction", async () => {
		const f = routes({
			"GET /subscriptions/sub_1": sub({ next_transaction: null }),
			"GET /transactions": [
				{ id: "txn_renewal", items: [{ price: { custom_data: null } }] },
				{ id: "txn_charge", items: [{ price: { custom_data: { kind: "usage_charge", usageChargeId: "uc-1" } } }] },
			],
		});
		await expect(findPostedCharge(client(f), "sub_1", "uc-1", PRODUCT)).resolves.toEqual({ providerRef: "txn_charge" });
	});

	it("is null only when neither place has it — another row's charge is not ours", async () => {
		const f = routes({
			"GET /subscriptions/sub_1": sub(),
			"GET /transactions": [{ id: "txn_x", items: [{ price: { custom_data: { kind: "usage_charge", usageChargeId: "uc-2" } } }] }],
		});
		await expect(findPostedCharge(client(f), "sub_1", "uc-1", PRODUCT)).resolves.toBeNull();
	});

	it("throws (never answers 'not found') when a lookup fails", async () => {
		const f = routes({ "GET /subscriptions/sub_1": sub() }); // /transactions → 404
		await expect(findPostedCharge(client(f), "sub_1", "uc-1", PRODUCT)).rejects.toBeInstanceOf(PaddleApiError);
	});
});

describe("isDefiniteRefusal", () => {
	it("is true only for a 4xx that is not a timeout, conflict or rate limit", () => {
		expect(isDefiniteRefusal(new PaddleApiError("http", "x", { status: 400 }))).toBe(true);
		expect(isDefiniteRefusal(new PaddleApiError("http", "x", { status: 422 }))).toBe(true);
		for (const status of [408, 409, 429, 500, 503]) {
			expect(isDefiniteRefusal(new PaddleApiError("http", "x", { status }))).toBe(false);
		}
		expect(isDefiniteRefusal(new PaddleApiError("timeout", "x"))).toBe(false);
		expect(isDefiniteRefusal(new PaddleApiError("network", "x"))).toBe(false);
		expect(isDefiniteRefusal(new PaddleApiError("invalid_response", "x", { status: 201 }))).toBe(false);
		expect(isDefiniteRefusal(new Error("x"))).toBe(false);
	});
});
