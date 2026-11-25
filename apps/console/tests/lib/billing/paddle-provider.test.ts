// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Paddle adapter (lib/billing/paddle/provider.ts): parseWebhook verifies before it parses and
// returns the normalized event; mode follows the KEY's prefix; the methods later lanes own refuse
// loudly instead of pretending; the L5 usage methods are wired (their logic is tested in
// paddle-overage*.test.ts and paddle-documents.test.ts).

import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { PaddleConfig } from "@/lib/billing/paddle/config";
import { createPaddleProvider, PaddleNotImplementedError, PaddleSignatureError } from "@/lib/billing/paddle/provider";
import { CATALOG, envelope, subscriptionData } from "../../fixtures/paddle-events";

const SECRET = "pdl_ntfset_provider_test";
const NOW = 1_795_000_000;
const savedKey = process.env.PADDLE_API_KEY;

afterEach(() => {
	if (savedKey === undefined) delete process.env.PADDLE_API_KEY;
	else process.env.PADDLE_API_KEY = savedKey;
});

/** A config carrying only what parseWebhook reads. */
function config(): PaddleConfig {
	return {
		environment: "sandbox",
		apiKey: "pdl_sdbx_apikey_x",
		webhookSecret: SECRET,
		clientToken: "test_x",
		prices: CATALOG.prices,
		products: {},
		appUrl: "https://console.example.invalid",
	};
}

const provider = createPaddleProvider({ config, nowMs: () => NOW * 1000 });

/** Headers carrying a Paddle-Signature for `body`. */
function signed(body: string, secret = SECRET): Headers {
	const h1 = createHmac("sha256", secret).update(`${NOW}:${body}`).digest("hex");
	return new Headers({ "paddle-signature": `ts=${NOW};h1=${h1}` });
}

describe("createPaddleProvider().parseWebhook", () => {
	it("returns the normalized event for a genuine delivery", async () => {
		const body = JSON.stringify(envelope("subscription.created", subscriptionData()));
		const events = await provider.parseWebhook({ rawBody: body, headers: signed(body) });
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ provider: "paddle", kind: "subscription_upserted", subscriptionId: "sub_01test" });
	});

	it("refuses a forged delivery before parsing the body", async () => {
		const body = "this is not even JSON";
		await expect(provider.parseWebhook({ rawBody: body, headers: signed(body, "wrong") })).rejects.toBeInstanceOf(
			PaddleSignatureError,
		);
	});
});

describe("createPaddleProvider() identity and mode", () => {
	it("is the paddle merchant of record", () => {
		expect(provider.id).toBe("paddle");
		expect(provider.sellerOfRecord).toBe("paddle");
	});

	it("reads its mode from the key prefix", () => {
		process.env.PADDLE_API_KEY = "pdl_sdbx_apikey_abc";
		expect(provider.mode()).toBe("test");
		expect(provider.isConfigured()).toBe(true);
		process.env.PADDLE_API_KEY = "pdl_live_apikey_abc";
		expect(provider.mode()).toBe("live");
		process.env.PADDLE_API_KEY = "";
		expect(provider.mode()).toBeNull();
		expect(provider.isConfigured()).toBe(false);
	});
});

describe("methods later lanes own", () => {
	it("refuse with PaddleNotImplementedError", async () => {
		const ref = { organizationId: "o", subscriptionId: "sub_1", slot: "plan" as const };
		const calls = [
			provider.startPurchase({ organizationId: "o", userId: "u", item: { kind: "plan", plan: "team" }, returnUrl: "https://x.invalid" }),
			provider.managementUrl("o", "https://x.invalid"),
			provider.cancelAtPeriodEnd(ref),
			provider.resume(ref),
			provider.changePlan(ref, { kind: "plan", plan: "team" }),
			provider.livePrices(),
		];
		for (const call of calls) await expect(call).rejects.toBeInstanceOf(PaddleNotImplementedError);
	});
});

describe("L5 usage methods", () => {
	it("records job usage in our own ledger (true when there are minutes), never a provider meter", async () => {
		await expect(provider.reportJobUsage({ organizationId: "o", customerId: null, minutes: 1, idempotencyKey: "k" })).resolves.toBe(true);
		await expect(provider.reportJobUsage({ organizationId: "o", customerId: null, minutes: 0, idempotencyKey: "k" })).resolves.toBe(false);
	});

	it("refuses to post a usage charge when no runner-minutes product is configured", async () => {
		await expect(
			provider.postUsageCharge({
				usageChargeId: "c",
				organizationId: "o",
				subscriptionId: "sub_1",
				periodStart: new Date(0),
				periodEnd: new Date(1),
				overageMinutes: 1,
				amount: { minor: 100, currency: "eur" },
			}),
		).rejects.toThrow(/PADDLE_PRODUCT_RUNNER_MINUTES/);
	});
});
