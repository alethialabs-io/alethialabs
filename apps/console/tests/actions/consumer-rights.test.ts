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
	authorizeRead: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));
vi.mock("@/lib/billing/queries", () => ({ getOrgBilling: vi.fn() }));
vi.mock("@/lib/billing/stripe", () => ({ getStripe: vi.fn() }));
// The acknowledgement's own behaviour is tested in tests/lib/email/withdrawal-acknowledgement.test.ts;
// here only WHETHER and WHEN the action asks for it (#7339).
vi.mock("@/lib/email/withdrawal-email", () => ({
	sendWithdrawalAcknowledgementEmail: vi.fn(async () => true),
}));
vi.mock("@/lib/billing/operator-alert", () => ({ alertOperator: vi.fn(async () => true) }));
vi.mock("@/lib/billing/config", () => ({
	deploymentMode: vi.fn(() => "hosted"),
	isStripeConfigured: vi.fn(() => true),
}));

import { authorize, authorizeRead } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";
import { getStripe } from "@/lib/billing/stripe";
import { getOrgBilling } from "@/lib/billing/queries";
import { deploymentMode, isStripeConfigured } from "@/lib/billing/config";
import { sendWithdrawalAcknowledgementEmail } from "@/lib/email/withdrawal-email";
import { alertOperator } from "@/lib/billing/operator-alert";
import { WITHDRAWAL_BASIS } from "@repo/legal/commerce";
import {
	getWithdrawalRight,
	recordOrdinaryCancellation,
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
		placedByUserId: "u-1",
		capacity: "consumer",
		state: "active",
		billingCountry: "DE",
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
	// The actions read the clock themselves (a Server Action's arguments come from the request), so
	// time is pinned by faking `Date` rather than by passing an instant in. Only `Date` is faked, so
	// promise and timer scheduling behave normally.
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(NOW);
	// Re-armed here, not only in the module factory: afterEach's resetAllMocks clears the factory's
	// implementations too, so a later test would see `isStripeConfigured()` return undefined and be
	// refused by the hosted-billing guard for a reason that has nothing to do with what it asserts.
	vi.mocked(isStripeConfigured).mockReturnValue(true);
	vi.mocked(deploymentMode).mockReturnValue("hosted");
	vi.mocked(authorize).mockResolvedValue({
		userId: "u-1",
		orgId: ORG,
	} as unknown as Awaited<ReturnType<typeof authorize>>);
	vi.mocked(authorizeRead).mockResolvedValue({
		userId: "u-1",
		orgId: ORG,
	} as unknown as Awaited<ReturnType<typeof authorizeRead>>);
});
afterEach(() => {
	vi.useRealTimers();
	vi.resetAllMocks();
});

describe("the withdrawal preview", () => {
	// Shown BEFORE the consumer acts, because they must be told what withdrawing will cost them —
	// a figure produced only afterwards is not that.
	it("quotes the proportional split for an acknowledged immediate start", () => {
		stubDb([order({ daysAgo: 10 })]);
		return getWithdrawalRight().then((r) => {
			expect(r.available).toBe(true);
			expect(r.retainedMinorUnits).toBe(4_000); // 10/30 of 12000
			expect(r.refundMinorUnits).toBe(8_000);
			expect(r.currency).toBe("eur");
			expect(r.basis).toBeTruthy();
		});
	});

	it("is unavailable on an organization order, and says why", async () => {
		stubDb([order({ capacity: "organization" })]);
		const r = await getWithdrawalRight();
		expect(r.available).toBe(false);
		expect(r.reason).toBe("not_a_consumer_order");
	});

	it("is unavailable once the 14 days have run, and says when they did", async () => {
		stubDb([order({ daysAgo: 20 })]);
		const r = await getWithdrawalRight();
		expect(r.available).toBe(false);
		expect(r.reason).toBe("period_expired");
		expect(r.expiresAt).toBeTruthy();
	});

	it("is unavailable when there is no order at all", async () => {
		stubDb([]);
		expect((await getWithdrawalRight()).reason).toBe("no_order");
	});
	// The billing page mounts this read on every load. `authorize` records an ALLOWED
	// "manage_billing" activity row (manage_billing is not read-only in lib/authz/activity.ts), so a
	// page view became an audit entry — and, landing fire-and-forget, a row inside the Cancel window
	// of `billing.subscription.cancel` in e2e/audit/destructive.spec.ts. The read must take the
	// read guard, which records only a denial.
	it("is gated as a READ, so viewing it writes no activity row", async () => {
		stubDb([order()]);
		await getWithdrawalRight();
		expect(authorizeRead).toHaveBeenCalledWith("manage_billing", { type: "billing" });
		expect(authorize).not.toHaveBeenCalled();
	});

	it("still refuses a caller the read guard denies", async () => {
		stubDb([order()]);
		vi.mocked(authorizeRead).mockRejectedValue(new Error("forbidden"));
		await expect(getWithdrawalRight()).rejects.toThrow("forbidden");
	});
});

describe("exercising the withdrawal", () => {
	// THE ordering property. Refund first: a recorded withdrawal must always correspond to money
	// that actually moved, and access must not end while the refund could still fail.
	it("refunds, then ends access, then records — in that order", async () => {
		const updates = stubDb([order({ daysAgo: 10 })]);
		const stripe = stubStripe();

		const out = await withdrawFromContract({ reason: null });

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
		await withdrawFromContract({ reason: null });
		expect(updates.at(-1)?.accessEndsAt).toEqual(NOW);
	});

	// The sanction for not obtaining the acknowledgement: service really was supplied, and the
	// trader may still keep nothing.
	it("refunds everything when immediate performance was never acknowledged", async () => {
		stubDb([order({ daysAgo: 10, proportionalChargeAcknowledgedAt: null })]);
		const stripe = stubStripe();
		const out = await withdrawFromContract({ reason: null });
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
		const out = await withdrawFromContract({ reason: null });
		expect(out.refundMinorUnits).toBe(0);
		expect(stripe.refunds.create).not.toHaveBeenCalled();
		expect(stripe.subscriptions.cancel).toHaveBeenCalled();
	});

	it("refuses an organization order and points at cancellation instead", async () => {
		stubDb([order({ capacity: "organization" })]);
		stubStripe();
		await expect(withdrawFromContract({ reason: null })).rejects.toThrow(
			/cancel it instead/i,
		);
	});

	it("refuses once the period has expired, naming the date", async () => {
		stubDb([order({ daysAgo: 30 })]);
		stubStripe();
		await expect(withdrawFromContract({ reason: null })).rejects.toThrow(
			/withdrawal period for this order ended/i,
		);
	});

	it("refuses a second withdrawal from the same order", async () => {
		stubDb([order({ state: "withdrawn" })]);
		stubStripe();
		await expect(withdrawFromContract({ reason: null })).rejects.toThrow(
			/already been withdrawn/i,
		);
	});

	// A consumer need give NO reason, and requiring one would be an obstacle to a right they cannot
	// be made to justify.
	it("does not require a reason", async () => {
		stubDb([order({ daysAgo: 3 })]);
		stubStripe();
		await expect(withdrawFromContract(undefined)).resolves.toBeTruthy();
	});

	// An owed refund with no payment intent on the order cannot be issued. The withdrawal still takes
	// effect, but the record must not claim a refund that never moved.
	it("does not record a refund it could not issue", async () => {
		const updates = stubDb([order({ daysAgo: 10, stripePaymentIntentId: null })]);
		const stripe = stubStripe();
		const out = await withdrawFromContract({ reason: null });
		expect(stripe.refunds.create).not.toHaveBeenCalled();
		expect(out.refundIssued).toBe(false);
		expect(out.refundMinorUnits).toBe(8_000); // still owed, and still reported as owed
		expect(updates.at(-1)).toMatchObject({
			state: "withdrawn",
			withdrawalRefundMinorUnits: null,
			withdrawalRetainedMinorUnits: 4_000,
		});
	});

	it("reports the refund as issued when it was", async () => {
		stubDb([order({ daysAgo: 10 })]);
		stubStripe();
		expect((await withdrawFromContract({ reason: null })).refundIssued).toBe(true);
	});

	// The acknowledgement on a durable medium (CRD art. 11a, ЗЗП art. 52a) — sent only AFTER the
	// withdrawal is recorded, so it can never acknowledge one that did not take effect, and carrying
	// the split the action computed rather than figures of its own.
	it("acknowledges the withdrawal after recording it, with the recorded split", async () => {
		const updates = stubDb([order({ daysAgo: 10 })]);
		stubStripe();
		let recordedBeforeSend = false;
		vi.mocked(sendWithdrawalAcknowledgementEmail).mockImplementation(async () => {
			recordedBeforeSend = updates.at(-1)?.state === "withdrawn";
			return true;
		});
		await withdrawFromContract({ reason: null });
		expect(recordedBeforeSend).toBe(true);
		expect(sendWithdrawalAcknowledgementEmail).toHaveBeenCalledOnce();
		expect(sendWithdrawalAcknowledgementEmail).toHaveBeenCalledWith({
			orderId: "order-1",
			placedByUserId: "u-1",
			withdrawnAt: NOW,
			refundMinorUnits: 8_000,
			retainedMinorUnits: 4_000,
			currency: "eur",
			refundIssued: true,
			basis: WITHDRAWAL_BASIS.en.proportional(10, 30),
			locale: "en",
		});
	});

	// ЗЗП art. 52a: a Bulgarian consumer is acknowledged in Bulgarian, and the basis the email quotes
	// is computed in that language. The split is the same either way (#7351).
	it("acknowledges a Bulgarian consumer in Bulgarian, with the same split", async () => {
		stubDb([order({ daysAgo: 10, billingCountry: "BG" })]);
		stubStripe();
		await withdrawFromContract({ reason: null });
		expect(sendWithdrawalAcknowledgementEmail).toHaveBeenCalledWith(
			expect.objectContaining({
				refundMinorUnits: 8_000,
				retainedMinorUnits: 4_000,
				basis: WITHDRAWAL_BASIS["bg-BG"].proportional(10, 30),
				locale: "bg-BG",
			}),
		);
	});

	// The page promises "we contact you within 14 days to arrange it" for a refund that could not be
	// issued automatically. The alert is what puts that in front of a person, and the email is told
	// so it can say that sentence.
	it("alerts the operator, and tells the email, when an owed refund could not be issued", async () => {
		stubDb([order({ daysAgo: 10, stripePaymentIntentId: null })]);
		stubStripe();
		await withdrawFromContract({ reason: null });
		expect(alertOperator).toHaveBeenCalledWith(
			expect.objectContaining({
				subject: { type: "user", id: "u-1" },
				summary: expect.stringMatching(/order order-1 .*within 14 days/),
			}),
		);
		expect(sendWithdrawalAcknowledgementEmail).toHaveBeenCalledWith(
			expect.objectContaining({ refundIssued: false }),
		);
	});

	it("does not alert the operator when the refund was issued", async () => {
		stubDb([order({ daysAgo: 10 })]);
		stubStripe();
		await withdrawFromContract({ reason: null });
		expect(alertOperator).not.toHaveBeenCalled();
	});

	it("sends no acknowledgement for a refused withdrawal", async () => {
		stubDb([order({ daysAgo: 30 })]);
		stubStripe();
		await expect(withdrawFromContract({ reason: null })).rejects.toThrow();
		expect(sendWithdrawalAcknowledgementEmail).not.toHaveBeenCalled();
	});

	it("sends no acknowledgement when the refund fails, because nothing was recorded", async () => {
		stubDb([order({ daysAgo: 10 })]);
		const stripe = stubStripe();
		stripe.refunds.create.mockRejectedValueOnce(new Error("stripe down"));
		await expect(withdrawFromContract({ reason: null })).rejects.toThrow(/stripe down/);
		expect(sendWithdrawalAcknowledgementEmail).not.toHaveBeenCalled();
	});
});

describe("the clock is the server's", () => {
	// A Server Action's arguments come from the request. Earlier signatures took the instant as a
	// trailing parameter; these calls pass one anyway (through Reflect.apply, which the action's
	// typed signature would otherwise refuse) and prove it changes nothing.
	const EARLIER = new Date(NOW.getTime() - 9 * 86_400_000);

	it("ignores an extra argument to the preview", async () => {
		stubDb([order({ daysAgo: 10 })]);
		const r: Awaited<ReturnType<typeof getWithdrawalRight>> = await Reflect.apply(
			getWithdrawalRight,
			undefined,
			[EARLIER],
		);
		expect(r.refundMinorUnits).toBe(8_000);
		expect(r.retainedMinorUnits).toBe(4_000);
	});

	it("ignores an extra argument to the withdrawal — the refund and the window are unchanged", async () => {
		const updates = stubDb([order({ daysAgo: 10 })]);
		const stripe = stubStripe();
		const out: Awaited<ReturnType<typeof withdrawFromContract>> = await Reflect.apply(
			withdrawFromContract,
			undefined,
			[{ reason: null }, EARLIER],
		);
		expect(out.refundMinorUnits).toBe(8_000);
		expect(stripe.refunds.create).toHaveBeenCalledWith(
			expect.objectContaining({ amount: 8_000 }),
		);
		expect(updates.at(-1)).toMatchObject({ withdrawnAt: NOW, accessEndsAt: NOW });
	});

	it("refuses an expired window even when an in-window instant is passed", async () => {
		stubDb([order({ daysAgo: 20 })]);
		const stripe = stubStripe();
		const fiveDaysAfterPlacement = new Date(NOW.getTime() - 15 * 86_400_000);
		await expect(
			Reflect.apply(withdrawFromContract, undefined, [
				{ reason: null },
				fiveDaysAfterPlacement,
			]),
		).rejects.toThrow(/withdrawal period for this order ended/i);
		expect(stripe.refunds.create).not.toHaveBeenCalled();
	});
});

describe("recording an ordinary cancellation", () => {
	it("ends access at the billing row's period end for this order's subscription", async () => {
		const periodEnd = new Date(NOW.getTime() + 12 * 86_400_000);
		const updates = stubDb([order({ daysAgo: 5 })]);
		vi.mocked(getOrgBilling).mockResolvedValue({
			stripeSubscriptionId: "sub_1",
			currentPeriodEnd: periodEnd,
		} as unknown as Awaited<ReturnType<typeof getOrgBilling>>);
		await recordOrdinaryCancellation();
		expect(updates.at(-1)).toMatchObject({
			state: "cancelled",
			cancelledAt: NOW,
			accessEndsAt: periodEnd,
		});
	});

	it("falls back to the order's own period when the billing row is another subscription", async () => {
		const updates = stubDb([order({ daysAgo: 35 })]); // 30-day periods: second period ends 25 days out
		vi.mocked(getOrgBilling).mockResolvedValue({
			stripeSubscriptionId: "sub_other",
			currentPeriodEnd: new Date(NOW.getTime() + 300 * 86_400_000),
		} as unknown as Awaited<ReturnType<typeof getOrgBilling>>);
		await recordOrdinaryCancellation();
		expect(updates.at(-1)?.accessEndsAt).toEqual(
			new Date(NOW.getTime() + 25 * 86_400_000),
		);
	});

	it("ignores a caller-supplied access end", async () => {
		const updates = stubDb([order({ daysAgo: 5 })]);
		vi.mocked(getOrgBilling).mockResolvedValue(null);
		await Reflect.apply(recordOrdinaryCancellation, undefined, [
			new Date(NOW.getTime() + 3650 * 86_400_000),
		]);
		expect(updates.at(-1)?.accessEndsAt).toEqual(
			new Date(NOW.getTime() + 25 * 86_400_000),
		);
	});
});
