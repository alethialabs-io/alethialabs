// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Paddle config (Paddle Billing L1): every value must agree on ONE environment. A sandbox key under
// PADDLE_ENVIRONMENT=live (or a live client token beside a sandbox key) is a deploy mistake that would
// send real customers to a sandbox checkout or point a test deploy at real money — it must throw.
//
// Keys are CONSTRUCTED from their prefix, never written out whole, so no file in the tree holds a
// string shaped like a real Paddle key.

import { describe, expect, it } from "vitest";
import { isPaddleConfigured, parsePaddleConfig } from "@/lib/billing/paddle/config";
import { paddleApiKey, paddleKeyEnvironment } from "@/lib/billing/paddle-key";

const SANDBOX_KEY = `pdl_sdbx_apikey_${"a".repeat(20)}`;
const LIVE_KEY = `pdl_live_apikey_${"b".repeat(20)}`;

/** A complete, consistent sandbox env, overridden by `over`. */
function env(over: Record<string, string | undefined> = {}): Record<string, string | undefined> {
	return {
		PADDLE_ENVIRONMENT: "sandbox",
		PADDLE_API_KEY: SANDBOX_KEY,
		PADDLE_WEBHOOK_SECRET: "whsec-paddle-test",
		NEXT_PUBLIC_PADDLE_CLIENT_TOKEN: "test_abc123",
		PADDLE_PRICE_TEAM: "pri_01team",
		NEXT_PUBLIC_APP_URL: "https://console.test",
		...over,
	};
}

describe("parsePaddleConfig", () => {
	it("accepts a consistent sandbox config", () => {
		const c = parsePaddleConfig(env());
		expect(c.environment).toBe("sandbox");
		expect(c.prices.team).toBe("pri_01team");
		expect(c.prices.aiPlus).toBeUndefined();
	});

	it("accepts a consistent live config", () => {
		const c = parsePaddleConfig(
			env({ PADDLE_ENVIRONMENT: "live", PADDLE_API_KEY: LIVE_KEY, NEXT_PUBLIC_PADDLE_CLIENT_TOKEN: "live_abc" }),
		);
		expect(c.environment).toBe("live");
	});

	it("throws on a sandbox key under PADDLE_ENVIRONMENT=live", () => {
		expect(() =>
			parsePaddleConfig(env({ PADDLE_ENVIRONMENT: "live", NEXT_PUBLIC_PADDLE_CLIENT_TOKEN: "live_abc" })),
		).toThrow(/PADDLE_API_KEY must start with pdl_live_apikey_/);
	});

	it("throws on a live key under PADDLE_ENVIRONMENT=sandbox", () => {
		expect(() => parsePaddleConfig(env({ PADDLE_API_KEY: LIVE_KEY }))).toThrow(
			/PADDLE_API_KEY must start with pdl_sdbx_apikey_/,
		);
	});

	it("throws on a client token from the other environment", () => {
		expect(() => parsePaddleConfig(env({ NEXT_PUBLIC_PADDLE_CLIENT_TOKEN: "live_abc" }))).toThrow(
			/NEXT_PUBLIC_PADDLE_CLIENT_TOKEN must start with test_/,
		);
	});

	it("throws on a key that is not a Paddle key at all", () => {
		expect(() => parsePaddleConfig(env({ PADDLE_API_KEY: "sk_test_123" }))).toThrow(/non-Paddle/);
	});

	it("never puts the key itself in the error", () => {
		let message = "";
		try {
			parsePaddleConfig(env({ PADDLE_API_KEY: LIVE_KEY }));
		} catch (err) {
			message = err instanceof Error ? err.message : String(err);
		}
		expect(message).toMatch(/Invalid Paddle config/);
		expect(message).not.toContain(LIVE_KEY);
	});

	it.each([
		["unset environment", { PADDLE_ENVIRONMENT: undefined }],
		["unknown environment", { PADDLE_ENVIRONMENT: "production" }],
		["missing webhook secret", { PADDLE_WEBHOOK_SECRET: "" }],
		["missing team price", { PADDLE_PRICE_TEAM: undefined }],
		["a team price that is not a price id", { PADDLE_PRICE_TEAM: "price_123" }],
		["a runner-minutes product that is not a product id", { PADDLE_PRODUCT_RUNNER_MINUTES: "pri_x" }],
	])("throws on %s", (_label, over) => {
		expect(() => parsePaddleConfig(env(over))).toThrow(/Invalid Paddle config/);
	});

	it("reads a blank optional id as unset", () => {
		expect(parsePaddleConfig(env({ PADDLE_PRICE_AI_MAX: "  " })).prices.aiMax).toBeUndefined();
	});
});

describe("the one key reading", () => {
	it("trims, and treats blank as unset", () => {
		expect(paddleApiKey({ PADDLE_API_KEY: `${SANDBOX_KEY}\n` })).toBe(SANDBOX_KEY);
		expect(isPaddleConfigured({ PADDLE_API_KEY: "   " })).toBe(false);
		expect(isPaddleConfigured({})).toBe(false);
		expect(isPaddleConfigured({ PADDLE_API_KEY: SANDBOX_KEY })).toBe(true);
	});

	it("judges the environment from the key prefix", () => {
		expect(paddleKeyEnvironment(SANDBOX_KEY)).toBe("sandbox");
		expect(paddleKeyEnvironment(LIVE_KEY)).toBe("live");
		expect(paddleKeyEnvironment("")).toBeNull();
		expect(paddleKeyEnvironment("sk_live_x")).toBeNull();
	});

	it("parses the config from the SAME trimmed key the seam reads", () => {
		expect(parsePaddleConfig(env({ PADDLE_API_KEY: ` ${SANDBOX_KEY} ` })).apiKey).toBe(SANDBOX_KEY);
	});
});
