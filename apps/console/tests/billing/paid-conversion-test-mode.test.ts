// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// THE TEST-MODE SEAM in the paid-conversion gate (#5412, maintainer ruling 2026-10-03).
//
// `PAID_MARKETS` is empty, so `assertPaidConversionAllowed` refuses every sale with
// `market_closed` — which also meant the release gate could never reach Stripe Elements, the order
// summary, the currency toggle or a hosted Checkout session. The ruling opens the market check for
// ONE configuration: a Stripe TEST secret key AND the gate-only flag. This file pins all four
// flag × key-mode cells through the gate itself, not through the helper alone, so the cells
// describe what a conversion actually gets.
//
// The cell that matters most is LIVE KEY + FLAG → refused. A copied env or a mistaken deploy that
// carries the flag into production must not turn into an open market.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** What the stubbed acceptance lookup returns: a row means the current Terms were accepted. */
let acceptanceRows: Array<{ id: string }> = [{ id: "accepted-1" }];

vi.mock("@/lib/db", () => {
	const chain = {
		select: () => chain,
		from: () => chain,
		where: () => chain,
		limit: () => Promise.resolve(acceptanceRows),
	};
	return { getServiceDb: () => chain };
});

import { PAID_MARKETS } from "@repo/legal/commerce";
import {
	assertPaidConversionAllowed,
	type PaidConversionContext,
	PaidConversionNotAllowedError,
	type PaidConversionRefusal,
	TEST_MODE_MARKET_FLAG,
	testModeMarketOpen,
} from "@/lib/billing/eligibility";

const TEST_KEY = "sk_test_51Example";
const LIVE_KEY = "sk_live_51Example";

/** A fully declared organization purchase, so the only open question is the market. */
const DECLARED: PaidConversionContext = {
	userId: "u-1",
	organizationId: "org-1",
	capacity: "organization",
	billingCountry: "DE",
};

/** The refusal reason the gate throws for `ctx`, or "allowed" when it lets the sale through. */
async function verdict(
	ctx: PaidConversionContext = DECLARED,
): Promise<PaidConversionRefusal | "allowed"> {
	try {
		await assertPaidConversionAllowed(ctx);
		return "allowed";
	} catch (err) {
		if (err instanceof PaidConversionNotAllowedError) return err.reason;
		throw err;
	}
}

/** Sets (or unsets, with undefined) the two inputs the seam reads. */
function setEnv(key: string | undefined, flag: string | undefined): void {
	vi.stubEnv("STRIPE_SECRET_KEY", key);
	vi.stubEnv(TEST_MODE_MARKET_FLAG, flag);
}

beforeEach(() => {
	acceptanceRows = [{ id: "accepted-1" }];
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("the premise: no market is open", () => {
	// If a cell were ever opened, every "refused" below would still be refused for DE/organization
	// only by coincidence. Pin the premise so the four cells keep meaning what they say.
	it("PAID_MARKETS is still empty", () => {
		expect(PAID_MARKETS).toHaveLength(0);
	});
});

describe("the four flag × key-mode cells", () => {
	it("test key + flag → the market check is waived", async () => {
		setEnv(TEST_KEY, "1");
		expect(await verdict()).toBe("allowed");
	});

	it("test key, no flag → market_closed (every sandbox env and developer .env)", async () => {
		setEnv(TEST_KEY, undefined);
		expect(await verdict()).toBe("market_closed");
	});

	it("LIVE key + flag → market_closed (the flag can never open production)", async () => {
		setEnv(LIVE_KEY, "1");
		expect(await verdict()).toBe("market_closed");
	});

	it("live key, no flag → market_closed (production as it ships)", async () => {
		setEnv(LIVE_KEY, undefined);
		expect(await verdict()).toBe("market_closed");
	});
});

describe("the seam's edges stay closed", () => {
	it("refuses with the flag but no Stripe key at all", async () => {
		setEnv(undefined, "1");
		expect(await verdict()).toBe("market_closed");
	});

	it.each(["true", "yes", "0", " 1", ""])(
		"refuses a flag of %j — only exactly \"1\" opens it",
		async (flag) => {
			setEnv(TEST_KEY, flag);
			expect(await verdict()).toBe("market_closed");
		},
	);

	it.each(["rk_test_51Example", "sk_live_sk_test_", "xsk_test_1"])(
		"refuses %s — a key that only CONTAINS sk_test_, or a restricted key",
		async (key) => {
			setEnv(key, "1");
			expect(await verdict()).toBe("market_closed");
		},
	);

	it("reads the environment at call time, not at import", () => {
		setEnv(TEST_KEY, "1");
		expect(testModeMarketOpen()).toBe(true);
		setEnv(LIVE_KEY, "1");
		expect(testModeMarketOpen()).toBe(false);
	});
});

describe("only the MARKET check is waived", () => {
	// The gate run must walk the same declaration a customer does. A seam that skipped the earlier
	// doors would let the release gate pass a checkout no customer can reach.
	it("still refuses an account that has not accepted the current Terms", async () => {
		setEnv(TEST_KEY, "1");
		acceptanceRows = [];
		expect(await verdict()).toBe("terms_not_accepted");
	});

	it("still refuses an undeclared payer capacity", async () => {
		setEnv(TEST_KEY, "1");
		expect(await verdict({ ...DECLARED, capacity: null })).toBe("capacity_not_declared");
	});

	it("still refuses a missing billing country", async () => {
		setEnv(TEST_KEY, "1");
		expect(await verdict({ ...DECLARED, billingCountry: null })).toBe(
			"billing_country_missing",
		);
	});
});
