// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Mocked-boundary tests for the STATUTORY WITHDRAWAL path (#2372).
//
// The accounting itself is pure and tested in @repo/legal (commerce.test.ts). What is tested here is
// the ORCHESTRATION, and specifically the two things that decide whether a withdrawing consumer is
// actually made whole:
//
//   · the ORDER of operations — refund, then end access, then record. Any other order can leave a
//     consumer cut off with no refund, or a record claiming money that never moved.
//   · the REFUSALS — withdrawal is a consumer right inside a window, and offering it outside either
//     is not generosity, it is a different legal act with different money attached.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/authz/guard", () => ({
	currentActor: vi.fn(),
	authorize: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));
vi.mock("@/lib/billing/stripe", () => ({ getStripe: vi.fn() }));
vi.mock("@/lib/billing/config", () => ({
	deploymentMode: vi.fn(() => "hosted"),
	isStripeConfigured: vi.fn(() => true),
}));

import { authorize } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";
import { getStripe } from "@/lib/billing/stripe";
import { deploymentMode, isStripeConfigured } from "@/lib/billing/config";
import {
	getWithdrawalRight,
	withdrawFromContract,
} from "@/app/server/actions/consumer-rights";

const ORG = "org-1";
const NOW = new Date("2026-08-24T12:00:00Z");

/** An order placed `daysAgo` before NOW, with the fields the accounting reads. */
function order(overrides: Record<string, unknown> = {}) {
	const daysAgo = typeof overrides.daysAgo === "number" ? overrides.daysAgo : 5;
	const rest = { ...overrides };
	delete rest.daysAgo;
	return {
		id: "order-1",
		organizationId: ORG,
		capacity: "consumer",
		state: "active",
		totalMinorUnits: 12_000,
		currency: "eur",
		periodDays: 30,
		placedAt: new Date(NOW.getTime() - daysAgo * 86_400_000),
		withdrawalPeriodEndsAt: null,
		performanceStart: "immediate",
		proportionalChargeAcknowledgedAt: new Date(
			NOW.getTime() - daysAgo * 86_400_000,
		),
		withdrawnAt: null,
		stripeSubscriptionId: "sub_1",
		stripePaymentIntentId: "pi_1",
		...rest,
	};
}

/** A drizzle-shaped stub returning `rows` from the select chain, recording updates. */
function stubDb(rows: unknown[]) {
	const updates: Record<string, unknown>[] = [];
	const chain = {
		select: () => chain,
		from: () => chain,
		where: () => chain,
		orderBy: () => chain,
		limit: () => Promise.resolve(rows),
		update: () => chain,
		set: (v: Record<string, unknown>) => {
			updates.push(v);
			return { where: () => Promise.resolve(undefined) };
		},
	};
	vi.mocked(getServiceDb).mockReturnValue(
		chain as unknown as ReturnType<typeof getServiceDb>,
	);
	return updates;
}

function stubStripe() {
	const calls: string[] = [];
	const refunds = { create: vi.fn(async () => { calls.push("refund"); return {}; }) };
	const subscriptions = { cancel: vi.fn(async () => { calls.push("cancel"); return {}; }) };
	vi.mocked(getStripe).mockReturnValue(
		{ refunds, subscriptions } as unknown as ReturnType<typeof getStripe>,
	);
	return { calls, refunds, subscriptions };
}

beforeEach(() => {
	// Re-armed here, not only in the module factory: afterEach's resetAllMocks clears the factory's
	// implementations too, so a later test would see `isStripeConfigured()` return undefined and be
	// refused by the hosted-billing guard for a reason that has nothing to do with what it asserts.
	vi.mocked(isStripeConfigured).mockReturnValue(true);
	vi.mocked(deploymentMode).mockReturnValue("hosted");
	vi.mocked(authorize).mockResolvedValue({
		userId: "u-1",
		orgId: ORG,
	} as unknown as Awaited<ReturnType<typeof authorize>>);
});
afterEach(() => vi.resetAllMocks());

describe("the withdrawal preview", () => {
	// Shown BEFORE the consumer acts, because they must be told what withdrawing will cost them —
	// a figure produced only afterwards is not that.
	it("quotes the proportional split for an acknowledged immediate start", () => {
		stubDb([order({ daysAgo: 10 })]);
		return getWithdrawalRight(NOW).then((r) => {
			expect(r.available).toBe(true);
			expect(r.retainedMinorUnits).toBe(4_000); // 10/30 of 12000
			expect(r.refundMinorUnits).toBe(8_000);
			expect(r.currency).toBe("eur");
			expect(r.basis).toBeTruthy();
		});
	});

	it("is unavailable on an organization order, and says why", async () => {
		stubDb([order({ capacity: "organization" })]);
		const r = await getWithdrawalRight(NOW);
		expect(r.available).toBe(false);
		expect(r.reason).toBe("not_a_consumer_order");
	});

	it("is unavailable once the 14 days have run, and says when they did", async () => {
		stubDb([order({ daysAgo: 20 })]);
		const r = await getWithdrawalRight(NOW);
		expect(r.available).toBe(false);
		expect(r.reason).toBe("period_expired");
		expect(r.expiresAt).toBeTruthy();
	});

	it("is unavailable when there is no order at all", async () => {
		stubDb([]);
		expect((await getWithdrawalRight(NOW)).reason).toBe("no_order");
	});
});

describe("exercising the withdrawal", () => {
	// THE ordering property. Refund first: a recorded withdrawal must always correspond to money
	// that actually moved, and access must not end while the refund could still fail.
	it("refunds, then ends access, then records — in that order", async () => {
		const updates = stubDb([order({ daysAgo: 10 })]);
		const stripe = stubStripe();

		const out = await withdrawFromContract({ reason: null }, NOW);

		expect(stripe.calls).toEqual(["refund", "cancel"]);
		expect(stripe.refunds.create).toHaveBeenCalledWith(
			expect.objectContaining({ payment_intent: "pi_1", amount: 8_000 }),
		);
		expect(out.refundMinorUnits).toBe(8_000);
		expect(out.retainedMinorUnits).toBe(4_000);
		// Recorded as `withdrawn`, NOT `cancelled` — different states with different money attached,
		// and a single "ended" flag would make "was this consumer refunded what they were owed?"
		// unanswerable from the record.
		expect(updates.at(-1)).toMatchObject({
			state: "withdrawn",
			withdrawalRefundMinorUnits: 8_000,
			withdrawalRetainedMinorUnits: 4_000,
		});
	});

	// Access ends AT ONCE on withdrawal, unlike cancellation which runs to the period end. The
	// contract is treated as never concluded, so continuing to serve it would supply under an
	// agreement that no longer exists.
	it("ends access immediately rather than at the period end", async () => {
		const updates = stubDb([order({ daysAgo: 2 })]);
		stubStripe();
		await withdrawFromContract({ reason: null }, NOW);
		expect(updates.at(-1)?.accessEndsAt).toEqual(NOW);
	});

	// The sanction for not obtaining the acknowledgement: service really was supplied, and the
	// trader may still keep nothing.
	it("refunds everything when immediate performance was never acknowledged", async () => {
		stubDb([order({ daysAgo: 10, proportionalChargeAcknowledgedAt: null })]);
		const stripe = stubStripe();
		const out = await withdrawFromContract({ reason: null }, NOW);
		expect(out.refundMinorUnits).toBe(12_000);
		expect(out.retainedMinorUnits).toBe(0);
		expect(stripe.refunds.create).toHaveBeenCalledWith(
			expect.objectContaining({ amount: 12_000 }),
		);
	});

	// No refund call at all when there is nothing to refund — a zero-amount refund is an error at
	// Stripe, and attempting one would fail the whole withdrawal.
	it("skips the refund call when the whole price is retained", async () => {
		stubDb([order({ daysAgo: 13, periodDays: 13 })]);
		const stripe = stubStripe();
		const out = await withdrawFromContract({ reason: null }, NOW);
		expect(out.refundMinorUnits).toBe(0);
		expect(stripe.refunds.create).not.toHaveBeenCalled();
		expect(stripe.subscriptions.cancel).toHaveBeenCalled();
	});

	it("refuses an organization order and points at cancellation instead", async () => {
		stubDb([order({ capacity: "organization" })]);
		stubStripe();
		await expect(withdrawFromContract({ reason: null }, NOW)).rejects.toThrow(
			/cancel it instead/i,
		);
	});

	it("refuses once the period has expired, naming the date", async () => {
		stubDb([order({ daysAgo: 30 })]);
		stubStripe();
		await expect(withdrawFromContract({ reason: null }, NOW)).rejects.toThrow(
			/withdrawal period for this order ended/i,
		);
	});

	it("refuses a second withdrawal from the same order", async () => {
		stubDb([order({ state: "withdrawn" })]);
		stubStripe();
		await expect(withdrawFromContract({ reason: null }, NOW)).rejects.toThrow(
			/already been withdrawn/i,
		);
	});

	// A consumer need give NO reason, and requiring one would be an obstacle to a right they cannot
	// be made to justify.
	it("does not require a reason", async () => {
		stubDb([order({ daysAgo: 3 })]);
		stubStripe();
		await expect(withdrawFromContract(undefined, NOW)).resolves.toBeTruthy();
	});
});
