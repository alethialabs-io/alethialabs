// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// THE EARLY ACCESS REFUSALS of the paid-conversion gate (#7324, EA-2).
//
// Each new door is measured through `assertPaidConversionAllowed` itself, with the earlier doors
// satisfied, so a verdict here is about the door it names and not about a check that ran first. The
// premise is today's: no cell is open, so a buyer who passes every Early Access door is refused
// `market_closed` — which is how "this door let them through" reads while PAID_MARKETS is empty.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** What each stubbed lookup returns: the acceptance row first, then whatever the test sets. */
const db = vi.hoisted(() => ({ rows: [{ id: "accepted-1" }] as unknown[] }));
vi.mock("@/lib/db", () => {
	const chain = {
		select: () => chain,
		from: () => chain,
		where: () => chain,
		limit: () => Promise.resolve(db.rows),
	};
	return { getServiceDb: () => chain };
});

const turnover = vi.hoisted(() => ({
	crossed: [] as unknown[],
	calls: [] as unknown[][],
}));
vi.mock("@/lib/billing/turnover", () => ({
	crossedThresholds: vi.fn(async (...args: unknown[]) => {
		turnover.calls.push(args);
		return turnover.crossed;
	}),
}));

import { PAID_MARKETS } from "@repo/legal/commerce";
import { LEGAL_ENTITY } from "@repo/legal/entity";
import {
	assertOrgPaidConversionAllowed,
	assertPaidConversionAllowed,
	type PaidConversionContext,
	PaidConversionNotAllowedError,
	type PaidConversionRefusal,
	TEST_MODE_MARKET_FLAG,
} from "@/lib/billing/eligibility";

/** An organization with every pre-Early Access fact declared. */
const ORG: PaidConversionContext = {
	userId: "u-1",
	organizationId: "org-1",
	capacity: "organization",
	billingCountry: "DE",
};

/** The refusal reason the gate throws for `ctx`, or "allowed". */
async function verdict(ctx: PaidConversionContext): Promise<PaidConversionRefusal | "allowed"> {
	try {
		await assertPaidConversionAllowed(ctx);
		return "allowed";
	} catch (err) {
		if (err instanceof PaidConversionNotAllowedError) return err.reason;
		throw err;
	}
}

beforeEach(() => {
	db.rows = [{ id: "accepted-1" }];
	turnover.crossed = [];
	turnover.calls = [];
	vi.stubEnv(TEST_MODE_MARKET_FLAG, undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe("the premise", () => {
	it("no cell is open, and the seller is not VAT-registered", () => {
		expect(PAID_MARKETS).toHaveLength(0);
		expect(LEGAL_ENTITY.vatRegistered).toBe(false);
	});
});

describe("vat_status_not_declared", () => {
	it("refuses an organization in another EU member state that has not said", async () => {
		expect(await verdict(ORG)).toBe("vat_status_not_declared");
		expect(await verdict({ ...ORG, vatIdGiven: null })).toBe("vat_status_not_declared");
		expect(await verdict({ ...ORG, billingCountry: "GR" })).toBe("vat_status_not_declared");
	});

	it("does not ask in Bulgaria, outside the EU, or of a consumer", async () => {
		expect(await verdict({ ...ORG, billingCountry: "BG" })).toBe("market_closed");
		expect(await verdict({ ...ORG, billingCountry: "GB" })).toBe("market_closed");
		expect(await verdict({ ...ORG, capacity: "consumer" })).toBe("market_closed");
	});

	it("comes after the country: a missing country is the first thing to fix", async () => {
		expect(await verdict({ ...ORG, billingCountry: null })).toBe("billing_country_missing");
	});
});

describe("state_missing", () => {
	it("refuses a US buyer with no state, or one that is not a USPS code", async () => {
		const us = { ...ORG, billingCountry: "US" };
		expect(await verdict(us)).toBe("state_missing");
		expect(await verdict({ ...us, billingState: "" })).toBe("state_missing");
		expect(await verdict({ ...us, billingState: "ZZ" })).toBe("state_missing");
		expect(await verdict({ ...us, capacity: "consumer" })).toBe("state_missing");
	});

	it("lets a US buyer with a state through to the market", async () => {
		expect(await verdict({ ...ORG, billingCountry: "US", billingState: "ny" })).toBe("market_closed");
	});
});

describe("complimentary_grant", () => {
	it("routes every non-BG EU business with a VAT number to the grant", async () => {
		for (const country of ["DE", "FR", "GR", "IE", "NL"]) {
			expect(await verdict({ ...ORG, billingCountry: country, vatIdGiven: true })).toBe(
				"complimentary_grant",
			);
		}
	});

	it("is not the answer for a BG business with a VAT number, nor for no VAT number", async () => {
		expect(await verdict({ ...ORG, billingCountry: "BG", vatIdGiven: true })).toBe("market_closed");
		expect(await verdict({ ...ORG, vatIdGiven: false })).toBe("market_closed");
	});

	it("is not waived by the test-mode flag — only the market check is", async () => {
		vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_51Example");
		vi.stubEnv(TEST_MODE_MARKET_FLAG, "1");
		expect(await verdict({ ...ORG, vatIdGiven: true })).toBe("complimentary_grant");
		expect(await verdict({ ...ORG, vatIdGiven: false })).toBe("allowed");
	});

	it("says what to do instead, and promises no charge for the free period", async () => {
		const refused = assertPaidConversionAllowed({ ...ORG, vatIdGiven: true });
		await expect(refused).rejects.toThrow(/complimentary Early Access/);
		await expect(refused).rejects.toThrow(/nothing is ever charged for the free period/);
	});
});

describe("the thresholds (us_state_closed, threshold_reached)", () => {
	/** A test-mode console, so the empty cell list does not refuse first. */
	function openMarket(): void {
		vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_51Example");
		vi.stubEnv(TEST_MODE_MARKET_FLAG, "1");
	}

	it("refuses a US sale whose state's threshold would be reached", async () => {
		openMarket();
		turnover.crossed = [
			{ counter: { id: "us_state", state: "NY" }, assessment: { verdict: "stop", usage: 1 } },
		];
		expect(await verdict({ ...ORG, billingCountry: "US", billingState: "NY" })).toBe(
			"us_state_closed",
		);
	});

	it("refuses an EU sale that would cross the BG or EU threshold", async () => {
		openMarket();
		turnover.crossed = [
			{ counter: { id: "bg_place_of_supply" }, assessment: { verdict: "stop", usage: 1.01 } },
		];
		expect(await verdict({ ...ORG, vatIdGiven: false })).toBe("threshold_reached");
	});

	it("asks the turnover with the buyer and the sale as declared", async () => {
		openMarket();
		await verdict({
			...ORG,
			billingCountry: "us",
			billingState: "ca",
			sale: { amountMinor: 2900, currency: "usd" },
		});
		expect(turnover.calls[0]).toEqual([
			{ country: "US", capacity: "organization", vatIdGiven: null, state: "CA" },
			{ amountMinor: 2900, currency: "usd" },
		]);
	});
});

describe("assertOrgPaidConversionAllowed reads the declared VAT status and state", () => {
	it("reads `not_given` as no VAT number, and passes the state", async () => {
		db.rows = [
			{
				id: "accepted-1",
				capacity: "organization",
				billingCountry: "DE",
				vatIdStatus: "not_given",
				billingState: null,
			},
		];
		await expect(assertOrgPaidConversionAllowed("u-1", "org-1")).rejects.toMatchObject({
			reason: "market_closed",
		});
	});

	it("reads `given` as a VAT number — the grant — and NULL as undeclared", async () => {
		db.rows = [{ id: "accepted-1", capacity: "organization", billingCountry: "FR", vatIdStatus: "given" }];
		await expect(assertOrgPaidConversionAllowed("u-1", "org-1")).rejects.toMatchObject({
			reason: "complimentary_grant",
		});
		db.rows = [{ id: "accepted-1", capacity: "organization", billingCountry: "FR", vatIdStatus: null }];
		await expect(assertOrgPaidConversionAllowed("u-1", "org-1")).rejects.toMatchObject({
			reason: "vat_status_not_declared",
		});
	});
});
