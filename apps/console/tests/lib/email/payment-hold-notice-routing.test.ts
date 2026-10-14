// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// Which copy a payment hold's Q3 email is sent in (#6011; ADR 0004 D8): `deliverHoldNotice`
// (lib/billing/payment-holds/emails.ts) chooses it by the hold's `scope`. A `new_org` hold is mailed
// the create-a-team copy at its payer's own address; an `org_plan` hold is mailed the org-plan copy at
// its Stripe customer's email; an `org_plan` adoption is refused before any read or send.
//
// The copy itself is pinned in payment-hold-notice-copy.test.ts. On `dev` the org_plan cases here fail:
// an org-plan hold was mailed through `sendPaymentHoldNoticeEmail`, the create-a-team copy.

import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	customerRetrieve: vi.fn(),
	payerRows: [] as { email: string }[],
}));

vi.mock("@/lib/db", () => ({
	getServiceDb: () => ({
		select: () => ({ from: () => ({ where: () => ({ limit: async () => h.payerRows }) }) }),
	}),
}));
vi.mock("@/lib/billing/stripe", () => ({
	getStripe: () => ({ customers: { retrieve: h.customerRetrieve } }),
	getPurchaseStripe: vi.fn(),
}));
vi.mock("@/lib/email/billing-email", () => ({
	sendPaymentHoldNoticeEmail: vi.fn(async () => undefined),
	sendOrgPlanHoldNoticeEmail: vi.fn(async () => undefined),
}));
vi.mock("@/lib/billing/payment-holds/store", () => ({
	claimHoldNotice: vi.fn(),
	unclaimHoldNotice: vi.fn(),
}));

import { deliverHoldNotice } from "@/lib/billing/payment-holds/emails";
import type { PaymentHoldRow } from "@/lib/db/schema";
import {
	type OrgPlanHoldNotice,
	sendOrgPlanHoldNoticeEmail,
	sendPaymentHoldNoticeEmail,
} from "@/lib/email/billing-email";

/** Every email an org-plan hold can be sent. */
const ORG_PLAN_NOTICES: OrgPlanHoldNotice[] = ["refund_pending", "released:refunded"];

const NOW = new Date("2026-10-14T12:00:00Z");
const PAYER = "6f1c2a4e-8b3d-4c5e-9f7a-1b2c3d4e5f60";

/** A payment-hold row; `over` replaces any column. */
function hold(over: Partial<PaymentHoldRow> = {}): PaymentHoldRow {
	return {
		id: "hold-1",
		subscription_id: "sub_x",
		customer_id: "cus_x",
		scope: "new_org",
		payer_key: PAYER,
		invoice_id: "in_x",
		payment_intent_id: null,
		state: "refund_pending",
		release_reason: null,
		released_at: null,
		released_by: null,
		release_note: null,
		refund_attempt: 0,
		attempts: 0,
		last_error: null,
		next_check_at: NOW,
		alerted_at: null,
		notice_last_sent_at: null,
		notified_state: null,
		notified_at: null,
		opened_by_user_id: PAYER,
		opened_by: "purchase",
		open_note: null,
		state_since: NOW,
		last_pay: null,
		refund_action_since: null,
		age_alerted_at: null,
		observed_at: NOW,
		nudged_at: null,
		version: 0,
		created_at: NOW,
		updated_at: NOW,
		...over,
	};
}

afterEach(() => {
	vi.mocked(sendPaymentHoldNoticeEmail).mockClear();
	vi.mocked(sendOrgPlanHoldNoticeEmail).mockClear();
	h.customerRetrieve.mockReset();
	h.payerRows = [];
});

describe("deliverHoldNotice — the copy follows the hold's scope (#6011)", () => {
	it.each(ORG_PLAN_NOTICES)(
		"an org_plan hold's %s goes out in the org-plan copy, to the customer's email",
		async (notice) => {
			h.customerRetrieve.mockResolvedValue({ deleted: false, email: "billing@team.example" });
			await deliverHoldNotice(hold({ scope: "org_plan", payer_key: "org-1" }), notice);
			expect(h.customerRetrieve).toHaveBeenCalledWith("cus_x");
			expect(vi.mocked(sendOrgPlanHoldNoticeEmail).mock.calls).toEqual([[{ to: "billing@team.example", notice }]]);
			expect(sendPaymentHoldNoticeEmail).not.toHaveBeenCalled();
		},
	);

	it("an org_plan adoption is refused before any read or send", async () => {
		await expect(
			deliverHoldNotice(hold({ scope: "org_plan", payer_key: "org-1" }), "released:adopted"),
		).rejects.toThrow(/never mailed/);
		expect(h.customerRetrieve).not.toHaveBeenCalled();
		expect(sendOrgPlanHoldNoticeEmail).not.toHaveBeenCalled();
		expect(sendPaymentHoldNoticeEmail).not.toHaveBeenCalled();
	});

	it("an org_plan hold whose customer has no email is mailed nothing", async () => {
		h.customerRetrieve.mockResolvedValue({ deleted: false, email: null });
		await deliverHoldNotice(hold({ scope: "org_plan", payer_key: "org-1" }), "refund_pending");
		expect(sendOrgPlanHoldNoticeEmail).not.toHaveBeenCalled();
		expect(sendPaymentHoldNoticeEmail).not.toHaveBeenCalled();
	});

	it("a new_org hold goes out in the create-a-team copy, to the payer's own address", async () => {
		h.payerRows = [{ email: "payer@example.test" }];
		await deliverHoldNotice(hold(), "refund_pending");
		expect(vi.mocked(sendPaymentHoldNoticeEmail).mock.calls).toEqual([
			[{ to: "payer@example.test", notice: "refund_pending" }],
		]);
		expect(sendOrgPlanHoldNoticeEmail).not.toHaveBeenCalled();
		expect(h.customerRetrieve).not.toHaveBeenCalled();
	});
});
