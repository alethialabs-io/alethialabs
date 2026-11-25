// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Paddle checkout (L4): the transaction is created server-side from the configured catalog, carries
// the custom_data contract L3 parses, and attaches the customer records when they could be made. The
// fake client answers through the REAL response schemas, so a shape the adapter cannot read fails here.

import { describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import { PaddleApiError, type PaddleClient, type PaddleRequest, parsePaddleData } from "@/lib/billing/paddle/api";
import {
	checkoutCustomData,
	createCheckoutTransaction,
	ensurePaddleCustomer,
	PaddleCatalogError,
	preparePaddleCustomer,
	transactionItems,
} from "@/lib/billing/paddle/checkout";
import type { PaddleConfig } from "@/lib/billing/paddle/config";
import { parseCustomData } from "@/lib/billing/paddle/events";
import { startPaddlePurchase } from "@/lib/billing/paddle/provider";
import { CATALOG, PRICE_AI_MAX, PRICE_TEAM } from "../../fixtures/paddle-events";

vi.mock("@/lib/observability/log", () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const ORDER = "33333333-3333-4333-8333-333333333333";

/** A config carrying the catalog and a credits product. */
function config(): PaddleConfig {
	return {
		environment: "sandbox",
		apiKey: "pdl_sdbx_apikey_x",
		webhookSecret: "secret",
		clientToken: "test_client",
		prices: CATALOG.prices,
		products: { aiCredits: "pro_01credits" },
		appUrl: "https://console.example.invalid",
	};
}

/** A fake client: records each request and answers from `respond` (a `{ data }` envelope), parsed as the real client does. */
function fakeClient(respond: (req: PaddleRequest) => unknown): { client: PaddleClient; calls: PaddleRequest[] } {
	const calls: PaddleRequest[] = [];
	const client: PaddleClient = {
		environment: "sandbox",
		async request<T extends z.ZodType>(req: PaddleRequest, data: T): Promise<z.infer<T>> {
			calls.push(req);
			return parsePaddleData(data, respond(req));
		},
		getEventTypes: async () => [],
	};
	return { client, calls };
}

/** The request bodies sent to `path`. */
function bodiesTo(calls: PaddleRequest[], method: string, path: string): unknown[] {
	return calls.filter((c) => c.method === method && c.path === path).map((c) => c.body);
}

describe("transactionItems", () => {
	it("prices Pro per seat from the configured catalog", () => {
		expect(transactionItems({ kind: "plan", plan: "team", seats: 4 }, config())).toEqual([
			{ price_id: PRICE_TEAM, quantity: 4 },
		]);
		expect(transactionItems({ kind: "plan", plan: "team" }, config())).toEqual([{ price_id: PRICE_TEAM, quantity: 1 }]);
	});

	it("prices an AI tier at quantity 1", () => {
		expect(transactionItems({ kind: "ai_tier", tier: "ai_max" }, config())).toEqual([
			{ price_id: PRICE_AI_MAX, quantity: 1 },
		]);
	});

	it("prices a credit pack as one non-catalog USD line on the credits product", () => {
		const items = transactionItems({ kind: "credit_pack", credits: 5000 }, config(), {
			credits: 5000,
			amountCents: 1900,
		});
		expect(items).toEqual([
			{
				quantity: 1,
				price: expect.objectContaining({
					product_id: "pro_01credits",
					unit_price: { amount: "1900", currency_code: "USD" },
					tax_mode: "account_setting",
				}),
			},
		]);
	});

	it("refuses what the catalog cannot price", () => {
		const noAi = { ...config(), prices: { team: PRICE_TEAM } };
		expect(() => transactionItems({ kind: "ai_tier", tier: "ai_plus" }, noAi)).toThrow(PaddleCatalogError);
		const noProduct = { ...config(), products: {} };
		expect(() =>
			transactionItems({ kind: "credit_pack", credits: 5000 }, noProduct, { credits: 5000, amountCents: 1900 }),
		).toThrow(PaddleCatalogError);
		// A pack whose price does not match the item is never sold.
		expect(() =>
			transactionItems({ kind: "credit_pack", credits: 5000 }, config(), { credits: 20000, amountCents: 5900 }),
		).toThrow(PaddleCatalogError);
	});
});

describe("checkoutCustomData", () => {
	it("writes the camelCase contract the webhook parses, for each kind", () => {
		const plan = checkoutCustomData({ organizationId: ORG, userId: USER, item: { kind: "plan", plan: "team" }, commerceOrderId: ORDER });
		expect(plan).toEqual({ organizationId: ORG, userId: USER, commerceOrderId: ORDER, kind: "plan", plan: "team" });
		const tier = checkoutCustomData({ organizationId: ORG, userId: USER, item: { kind: "ai_tier", tier: "ai_plus" } });
		expect(tier).toEqual({ organizationId: ORG, userId: USER, kind: "ai_tier", plan: "ai_plus" });
		const pack = checkoutCustomData({ organizationId: ORG, userId: USER, item: { kind: "credit_pack", credits: 5000 } });
		expect(pack).toEqual({ organizationId: ORG, userId: USER, kind: "credit_pack", credits: 5000 });
		// L3's parser reads each one back unchanged.
		for (const data of [plan, tier, pack]) expect(parseCustomData(data)).toEqual(data);
	});
});

describe("ensurePaddleCustomer", () => {
	it("reuses the customer named in Paddle's conflict answer", async () => {
		const { client } = fakeClient(() => {
			throw new PaddleApiError(
				"http",
				"Paddle POST /customers → 409 customer_already_exists: customer email conflicts with customer of id ctm_01existing",
				{ status: 409, code: "customer_already_exists" },
			);
		});
		await expect(ensurePaddleCustomer(client, { email: "a@example.com" })).resolves.toBe("ctm_01existing");
	});

	it("uses the org's known customer without asking Paddle", async () => {
		const { client, calls } = fakeClient(() => ({}));
		await expect(ensurePaddleCustomer(client, { email: "a@example.com", existing: { customerId: "ctm_known" } })).resolves.toBe(
			"ctm_known",
		);
		expect(calls).toHaveLength(0);
	});
});

describe("preparePaddleCustomer", () => {
	it("creates the customer, address and business, and continues without a step that fails", async () => {
		const skipped: string[] = [];
		const { client, calls } = fakeClient((req) => {
			if (req.path === "/customers") return { data: { id: "ctm_1" } };
			if (req.path === "/customers/ctm_1/addresses") return { data: { id: "add_1" } };
			throw new PaddleApiError("http", "business refused", { status: 400, code: "bad_request" });
		});
		const refs = await preparePaddleCustomer(
			client,
			{
				email: "a@example.com",
				name: "Acme",
				address: { countryCode: "de", postalCode: "10115", city: "Berlin", line1: "Str 1" },
				business: { name: "Acme GmbH", taxIdentifier: "DE123456789" },
			},
			(step) => skipped.push(step),
		);
		expect(refs).toEqual({ customerId: "ctm_1", addressId: "add_1", businessId: null });
		expect(skipped).toEqual(["business"]);
		expect(bodiesTo(calls, "POST", "/customers/ctm_1/addresses")).toEqual([
			{ country_code: "DE", postal_code: "10115", city: "Berlin", first_line: "Str 1" },
		]);
	});
});

describe("createCheckoutTransaction", () => {
	it("sends the items, custom_data and customer records, and returns only the id", async () => {
		const { client, calls } = fakeClient(() => ({ data: { id: "txn_01abc", status: "ready" } }));
		const id = await createCheckoutTransaction(client, {
			items: [{ price_id: PRICE_TEAM, quantity: 2 }],
			customData: { organizationId: ORG, kind: "plan", plan: "team" },
			customer: { customerId: "ctm_1", addressId: "add_1", businessId: "biz_1" },
		});
		expect(id).toBe("txn_01abc");
		expect(bodiesTo(calls, "POST", "/transactions")).toEqual([
			{
				items: [{ price_id: PRICE_TEAM, quantity: 2 }],
				custom_data: { organizationId: ORG, kind: "plan", plan: "team" },
				collection_mode: "automatic",
				customer_id: "ctm_1",
				address_id: "add_1",
				business_id: "biz_1",
			},
		]);
	});

	it("never attaches a business without an address", async () => {
		const { client, calls } = fakeClient(() => ({ data: { id: "txn_01abc", status: "draft" } }));
		await createCheckoutTransaction(client, {
			items: [{ price_id: PRICE_TEAM, quantity: 1 }],
			customData: { organizationId: ORG, kind: "plan", plan: "team" },
			customer: { customerId: "ctm_1", addressId: null, businessId: "biz_1" },
		});
		expect(bodiesTo(calls, "POST", "/transactions")[0]).toEqual({
			items: [{ price_id: PRICE_TEAM, quantity: 1 }],
			custom_data: { organizationId: ORG, kind: "plan", plan: "team" },
			collection_mode: "automatic",
			customer_id: "ctm_1",
		});
	});
});

describe("startPaddlePurchase (the adapter's startPurchase)", () => {
	it("returns the transaction to open with the client token, and the customer refs for the row", async () => {
		const { client, calls } = fakeClient((req) => {
			if (req.path === "/customers") return { data: { id: "ctm_1" } };
			if (req.path === "/transactions") return { data: { id: "txn_01pack", status: "ready" } };
			return { data: { id: "add_1" } };
		});
		const start = await startPaddlePurchase(
			{
				organizationId: ORG,
				userId: USER,
				item: { kind: "credit_pack", credits: 5000 },
				commerceOrderId: ORDER,
				returnUrl: "https://console.example.invalid/billing",
				buyer: { email: "a@example.com", address: { countryCode: "US", postalCode: "94105" } },
			},
			{ config, nowMs: () => 0, client: () => client },
		);
		expect(start).toEqual({
			kind: "paddle_checkout",
			transactionId: "txn_01pack",
			clientToken: "test_client",
			environment: "sandbox",
			customer: { customerId: "ctm_1", addressId: "add_1", businessId: null },
		});
		const [txn] = bodiesTo(calls, "POST", "/transactions");
		expect(txn).toMatchObject({
			custom_data: { organizationId: ORG, userId: USER, commerceOrderId: ORDER, kind: "credit_pack", credits: 5000 },
		});
	});

	it("refuses an uncatalogued item before any customer record is written", async () => {
		const { client, calls } = fakeClient(() => ({ data: { id: "x" } }));
		await expect(
			startPaddlePurchase(
				{ organizationId: ORG, userId: USER, item: { kind: "credit_pack", credits: 7 }, returnUrl: "https://x.invalid", buyer: { email: "a@example.com" } },
				{ config, nowMs: () => 0, client: () => client },
			),
		).rejects.toBeInstanceOf(PaddleCatalogError);
		expect(calls).toHaveLength(0);
	});
});
