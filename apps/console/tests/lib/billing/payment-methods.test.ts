// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/billing/stripe", () => ({ getStripe: vi.fn() }));

import { getStripe } from "@/lib/billing/stripe";
import {
	attemptBackupPayment,
	backupRankOf,
	BACKUP_RANK_KEY,
	setBackupOrder,
} from "@/lib/billing/payment-methods";

function makeStripe() {
	return {
		customers: { retrieve: vi.fn(), update: vi.fn() },
		paymentMethods: { list: vi.fn(), update: vi.fn() },
		invoices: { pay: vi.fn() },
	};
}
type StripeMock = ReturnType<typeof makeStripe>;
let stripe: StripeMock;

beforeEach(() => {
	vi.clearAllMocks();
	stripe = makeStripe();
	vi.mocked(getStripe).mockReturnValue(stripe as never);
});

/** A minimal PaymentMethod shape for the helpers under test. */
function pm(id: string, rank?: number) {
	return {
		id,
		customer: "cus_1",
		metadata: rank === undefined ? {} : { [BACKUP_RANK_KEY]: String(rank) },
	};
}

describe("backupRankOf", () => {
	it("reads a valid 0-based rank", () => {
		expect(backupRankOf(pm("pm_1", 0) as never)).toBe(0);
		expect(backupRankOf(pm("pm_1", 3) as never)).toBe(3);
	});
	it("returns null for unranked / invalid / negative", () => {
		expect(backupRankOf(pm("pm_1") as never)).toBeNull();
		expect(backupRankOf({ id: "x", metadata: { [BACKUP_RANK_KEY]: "" } } as never)).toBeNull();
		expect(backupRankOf({ id: "x", metadata: { [BACKUP_RANK_KEY]: "-1" } } as never)).toBeNull();
		expect(backupRankOf({ id: "x", metadata: { [BACKUP_RANK_KEY]: "abc" } } as never)).toBeNull();
	});
});

describe("setBackupOrder", () => {
	it("stamps rank by position and clears the rest", async () => {
		stripe.paymentMethods.list.mockResolvedValue({
			data: [pm("pm_a"), pm("pm_b"), pm("pm_c")],
		} as never);
		stripe.paymentMethods.update.mockResolvedValue({} as never);

		await setBackupOrder("cus_1", ["pm_b", "pm_a"]);

		const calls = Object.fromEntries(
			stripe.paymentMethods.update.mock.calls.map((c) => [
				c[0],
				c[1].metadata[BACKUP_RANK_KEY],
			]),
		);
		expect(calls).toEqual({ pm_a: "1", pm_b: "0", pm_c: "" });
	});

	it("rejects an id that isn't the customer's", async () => {
		stripe.paymentMethods.list.mockResolvedValue({ data: [pm("pm_a")] } as never);
		await expect(setBackupOrder("cus_1", ["pm_x"])).rejects.toThrow(/not found/i);
	});
});

describe("attemptBackupPayment", () => {
	beforeEach(() => {
		stripe.customers.retrieve.mockResolvedValue({
			invoice_settings: { default_payment_method: "pm_default" },
		} as never);
		stripe.customers.update.mockResolvedValue({} as never);
	});

	it("pays with the lowest-rank backup, skipping the default + failed card, and promotes it", async () => {
		stripe.paymentMethods.list.mockResolvedValue({
			data: [pm("pm_default"), pm("pm_hi", 1), pm("pm_lo", 0)],
		} as never);
		stripe.invoices.pay.mockResolvedValue({ status: "paid" } as never);

		const result = await attemptBackupPayment("cus_1", "in_1", "pm_default");

		expect(result).toBe("pm_lo");
		// Tried the lowest-rank backup first.
		expect(stripe.invoices.pay).toHaveBeenCalledWith("in_1", {
			payment_method: "pm_lo",
		});
		// Promoted the working card to default.
		expect(stripe.customers.update).toHaveBeenCalledWith("cus_1", {
			invoice_settings: { default_payment_method: "pm_lo" },
		});
	});

	it("falls through to the next backup when the first declines", async () => {
		stripe.paymentMethods.list.mockResolvedValue({
			data: [pm("pm_lo", 0), pm("pm_hi", 1)],
		} as never);
		stripe.invoices.pay
			.mockRejectedValueOnce(new Error("card_declined"))
			.mockResolvedValueOnce({ status: "paid" } as never);

		const result = await attemptBackupPayment("cus_1", "in_1", null);
		expect(result).toBe("pm_hi");
		expect(stripe.invoices.pay).toHaveBeenCalledTimes(2);
	});

	it("returns null when there are no ranked backups", async () => {
		stripe.paymentMethods.list.mockResolvedValue({
			data: [pm("pm_default"), pm("pm_unranked")],
		} as never);
		const result = await attemptBackupPayment("cus_1", "in_1", "pm_default");
		expect(result).toBeNull();
		expect(stripe.invoices.pay).not.toHaveBeenCalled();
	});

	it("returns null when every backup declines", async () => {
		stripe.paymentMethods.list.mockResolvedValue({
			data: [pm("pm_lo", 0), pm("pm_hi", 1)],
		} as never);
		stripe.invoices.pay.mockRejectedValue(new Error("card_declined"));
		const result = await attemptBackupPayment("cus_1", "in_1", null);
		expect(result).toBeNull();
	});
});
