// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The half of an erasure outside Postgres (lib/privacy/erasure-outside.ts): OpenFGA and Stripe,
// after the erasure committed.
//
// Pinned: the Stripe customer is deleted only when no retained invoice or order needs it, and KEPT
// with a reason otherwise; a failure of either system is recorded on the case and never thrown —
// the rows are already gone; and no ledger line names the Stripe customer, because the ledger
// outlives the erasure it records.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { scriptedDb } from "./scripted-db";

const sdb = scriptedDb();
vi.mock("@/lib/db", () => ({ getServiceDb: () => sdb.db }));
const { removeUserTuples, customersDel, getOrgBilling, upsertOrgBilling, configured } = vi.hoisted(() => ({
	removeUserTuples: vi.fn(),
	customersDel: vi.fn(),
	getOrgBilling: vi.fn(),
	upsertOrgBilling: vi.fn(),
	configured: vi.fn(),
}));
vi.mock("@/lib/authz/tuple-sync", () => ({ getTupleSync: () => ({ removeUserTuples }) }));
vi.mock("@/lib/billing/stripe", () => ({ getStripe: () => ({ customers: { del: customersDel } }) }));
vi.mock("@/lib/billing/config", () => ({ isStripeConfigured: () => configured() }));
vi.mock("@/lib/billing/queries", () => ({
	getOrgBilling: (...a: unknown[]) => getOrgBilling(...a),
	upsertOrgBilling: (...a: unknown[]) => upsertOrgBilling(...a),
}));

import { privacyCaseEvent } from "@/lib/db/schema";
import {
	deleteStripeCustomerIfUnretained,
	describeStripeOutcome,
	eraseOutsidePostgres,
} from "@/lib/privacy/erasure-outside";

const USER = "11111111-1111-1111-1111-111111111111";
const BILLING = {
	plan: "community",
	status: "none",
	stripeCustomerId: "cus_123",
	stripeSubscriptionId: null,
	seats: null,
	currentPeriodEnd: null,
};

beforeEach(() => {
	sdb.calls.length = 0;
	removeUserTuples.mockReset();
	removeUserTuples.mockResolvedValue(undefined);
	customersDel.mockReset();
	customersDel.mockResolvedValue({});
	getOrgBilling.mockReset();
	upsertOrgBilling.mockReset();
	configured.mockReset();
	configured.mockReturnValue(true);
});

describe("deleteStripeCustomerIfUnretained", () => {
	it("has nothing to do for an account with no Stripe customer", async () => {
		getOrgBilling.mockResolvedValue(null);
		expect(await deleteStripeCustomerIfUnretained(USER, USER)).toEqual({ outcome: "none" });
		expect(customersDel).not.toHaveBeenCalled();
	});

	it("deletes the customer and clears it from the billing record when nothing retained needs it", async () => {
		getOrgBilling.mockResolvedValue(BILLING);
		sdb.answer([{ n: 0 }], [{ n: 0 }]);
		expect(await deleteStripeCustomerIfUnretained(USER, USER)).toEqual({
			outcome: "deleted",
			customerId: "cus_123",
		});
		expect(customersDel).toHaveBeenCalledWith("cus_123");
		expect(upsertOrgBilling).toHaveBeenCalledWith(expect.objectContaining({ stripeCustomerId: null }));
	});

	it("keeps the customer while an invoice issued to it is retained by law", async () => {
		getOrgBilling.mockResolvedValue(BILLING);
		sdb.answer([{ n: 2 }], [{ n: 0 }]);
		const out = await deleteStripeCustomerIfUnretained(USER, USER);
		expect(out).toEqual({ outcome: "retained", customerId: "cus_123", invoices: 2, orders: 0 });
		expect(customersDel).not.toHaveBeenCalled();
	});

	it("reports a failed delete instead of throwing", async () => {
		getOrgBilling.mockResolvedValue(BILLING);
		sdb.answer([{ n: 0 }], [{ n: 0 }]);
		customersDel.mockRejectedValue(new Error("stripe down"));
		expect((await deleteStripeCustomerIfUnretained(USER, USER)).outcome).toBe("failed");
		expect(upsertOrgBilling).not.toHaveBeenCalled();
	});
});

describe("describeStripeOutcome", () => {
	it("never writes the customer id into the ledger line", () => {
		for (const r of [
			{ outcome: "deleted", customerId: "cus_123" },
			{ outcome: "retained", customerId: "cus_123", invoices: 1, orders: 1 },
			{ outcome: "failed", customerId: "cus_123" },
			{ outcome: "not_configured", customerId: "cus_123" },
		] as const) {
			expect(describeStripeOutcome(r)).not.toContain("cus_123");
		}
	});
});

describe("eraseOutsidePostgres", () => {
	it("records a failed OpenFGA removal and still handles Stripe", async () => {
		removeUserTuples.mockRejectedValue(new Error("fga down"));
		getOrgBilling.mockResolvedValue(null);
		await expect(eraseOutsidePostgres("case-1", USER, null)).resolves.toBeUndefined();
		const summaries = sdb.calls
			.filter((c) => c.table === privacyCaseEvent)
			.map((c) => (c.values as { detail: { summary: string } }).detail.summary);
		expect(summaries[0]).toContain("FAILED");
		expect(summaries[0]).toContain("backfill");
		expect(summaries[1]).toContain("no Stripe customer");
	});

	it("records the Stripe deletion as a vendor notification", async () => {
		getOrgBilling.mockResolvedValue(BILLING);
		sdb.answer([], [{ n: 0 }], [{ n: 0 }]);
		await eraseOutsidePostgres("case-1", USER, "admin-1");
		const kinds = sdb.calls
			.filter((c) => c.table === privacyCaseEvent)
			.map((c) => (c.values as { kind: string }).kind);
		expect(kinds).toEqual(["note", "vendor_notified"]);
		expect(removeUserTuples).toHaveBeenCalledWith(USER);
	});
});
