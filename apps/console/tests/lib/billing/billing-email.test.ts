// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Which subscription ITEM the billing emails read (lib/email/billing-email.ts, #4655).
//
// Lives under tests/lib/billing rather than tests/lib/email on purpose: the subject is the
// billing plan-item selection that `planItem` (lib/billing/sync.ts) owns, and #4655's `check:`
// line runs this directory. `@/lib/billing/sync` is deliberately left REAL — it is the predicate
// under test, and stubbing it would let the wrong answer pass.
//
// THE ORDER IS THE TEST. A subscription created with STRIPE_PRICE_METER_TEAM set carries two
// items — a licensed plan line and a metered runner-minutes line — and the Stripe API does not
// promise `items.data` in creation order. Every case below is asserted in BOTH orders, so a
// re-introduced `items.data[0]` fails one of the pair rather than neither.

import type Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/billing/config", () => ({ planForPriceId: vi.fn() }));
vi.mock("@/lib/billing/stripe", () => ({ getStripe: vi.fn() }));
vi.mock("@/lib/billing/odoo-invoice", () => ({ issueFactura: vi.fn() }));
// The org-name / owner-email lookups are not the subject here — a chainable stub that answers
// every builder shape billing-email.ts uses keeps the suite I/O-free.
vi.mock("@/lib/db", () => {
	/** A self-returning query builder whose `limit` resolves to one row. */
	const chain = {
		select: () => chain,
		from: () => chain,
		innerJoin: () => chain,
		where: () => chain,
		orderBy: () => chain,
		limit: async () => [{ name: "Acme", email: "owner@example.test" }],
	};
	return { getServiceDb: () => chain };
});
vi.mock("@repo/email/config", () => ({
	getEmailConfig: () => ({
		from: { general: "billing@example.test" },
		configSet: { general: "general" },
	}),
}));
vi.mock("@repo/plan-catalog", () => ({ planMeta: vi.fn() }));
vi.mock("@/lib/email/guard", () => ({ sendGuardedEmail: vi.fn() }));

// The react-email templates are stubbed to identity fns: this suite asserts the PROPS each
// email is built with, never their markup.
vi.mock("@/emails/credit-pack-receipt", () => ({
	CreditPackReceiptEmail: vi.fn(),
	subject: "credit pack",
}));
vi.mock("@/emails/payment-failed", () => ({ PaymentFailedEmail: vi.fn(), subject: "failed" }));
vi.mock("@/emails/receipt", () => ({ ReceiptEmail: vi.fn(), subject: "receipt" }));
vi.mock("@/emails/order-confirmation", () => ({
	OrderConfirmationEmail: vi.fn(),
	subject: "order",
}));
vi.mock("@/emails/subscription-canceled", () => ({
	SubscriptionCanceledEmail: vi.fn(),
	subject: "canceled",
}));
vi.mock("@/emails/trial-ending", () => ({ TrialEndingEmail: vi.fn(), subject: "trial ending" }));
vi.mock("@/emails/welcome-to-plan", () => ({
	WelcomeToPlanEmail: vi.fn(),
	subject: vi.fn(() => "welcome"),
}));

import {
	sendPlanWelcomeEmail,
	sendSubscriptionCanceledEmail,
	sendTrialEndingEmail,
} from "@/lib/email/billing-email";
import { planForPriceId } from "@/lib/billing/config";
import { formatDate } from "@repo/format";
import { planMeta } from "@repo/plan-catalog";
import { SubscriptionCanceledEmail } from "@/emails/subscription-canceled";
import { TrialEndingEmail } from "@/emails/trial-ending";
import { WelcomeToPlanEmail } from "@/emails/welcome-to-plan";

/** One subscription item, carrying only the fields the email path reads off it. */
function item(
	priceId: string,
	usageType: "licensed" | "metered",
	periodEnd: number,
): Stripe.SubscriptionItem {
	return {
		id: `si_${priceId}`,
		price: { id: priceId, recurring: { usage_type: usageType } },
		current_period_end: periodEnd,
	} as unknown as Stripe.SubscriptionItem;
}

const FLAT_PERIOD_END = 1_798_761_600; // 2027-01-01
const METER_PERIOD_END = 1_000_000_000; // 2001-09-09

/** The licensed plan line — an Enterprise price, see the `planForPriceId` stub below. */
const flat = item("price_enterprise", "licensed", FLAT_PERIOD_END);
/** The metered runner-minutes add-on, on a period end 25 YEARS from the plan line's, so that
 *  reading the wrong item can never be mistaken for a rendering difference. */
const meter = item("price_meter_team", "metered", METER_PERIOD_END);

// Rendered through the same `formatDate` the email uses: what these assertions pin is WHICH
// timestamp was read, not how it was formatted — and the two can never collide.
const flatLabel = formatDate(FLAT_PERIOD_END * 1000);
const meterLabel = formatDate(METER_PERIOD_END * 1000);

/** A subscription over the given items, in the given order. */
function sub(
	items: Stripe.SubscriptionItem[],
	over: { metadata?: Record<string, string>; trial_end?: number } = {},
): Stripe.Subscription {
	return {
		id: "sub_1",
		status: "active",
		customer: { id: "cus_1", email: "owner@example.test" },
		metadata: { organization_id: "org-1", ...over.metadata },
		items: { data: items },
		...(over.trial_end ? { trial_end: over.trial_end } : {}),
	} as unknown as Stripe.Subscription;
}

beforeEach(() => {
	vi.clearAllMocks();
	// Only the LICENSED price maps to a plan, and it maps to a plan that is NOT the `"team"`
	// default the email falls back to. That is deliberate: a meter price maps to nothing, so a
	// site that reads the meter resolves `null` and renders the default — which would COINCIDE
	// with the right answer if the licensed price were a Team price, and the test would pass
	// while the defect stood.
	vi.mocked(planForPriceId).mockImplementation((priceId) =>
		priceId === "price_enterprise" ? "enterprise" : null,
	);
	// `name` is what every assertion below reads; `tagline`/`highlights` are only there because
	// the welcome email destructures them.
	vi.mocked(planMeta).mockImplementation(
		(plan) => ({ name: `plan:${plan}`, tagline: "", highlights: [] }) as never,
	);
});

describe("sendSubscriptionCanceledEmail — two-item subscription", () => {
	it("reads the period end off the LICENSED line when the meter is listed FIRST", async () => {
		await sendSubscriptionCanceledEmail(sub([meter, flat]));
		expect(SubscriptionCanceledEmail).toHaveBeenCalledWith(
			expect.objectContaining({ accessUntilLabel: flatLabel }),
		);
		expect(SubscriptionCanceledEmail).not.toHaveBeenCalledWith(
			expect.objectContaining({ accessUntilLabel: meterLabel }),
		);
	});

	it("reads the period end off the LICENSED line when the meter is listed SECOND", async () => {
		await sendSubscriptionCanceledEmail(sub([flat, meter]));
		expect(SubscriptionCanceledEmail).toHaveBeenCalledWith(
			expect.objectContaining({ accessUntilLabel: flatLabel }),
		);
	});

	it("names the plan off the LICENSED line when the meter is listed FIRST", async () => {
		await sendSubscriptionCanceledEmail(sub([meter, flat]));
		expect(SubscriptionCanceledEmail).toHaveBeenCalledWith(
			expect.objectContaining({ planLabel: "plan:enterprise" }),
		);
	});
});

describe("sendTrialEndingEmail — two-item subscription", () => {
	it("names the plan off the LICENSED line when the meter is listed FIRST", async () => {
		await sendTrialEndingEmail(sub([meter, flat], { trial_end: 1_796_083_200 }));
		expect(TrialEndingEmail).toHaveBeenCalledWith(
			expect.objectContaining({ planLabel: "plan:enterprise" }),
		);
	});
});

describe("sendPlanWelcomeEmail — two-item subscription", () => {
	it("resolves the plan off the LICENSED line when the meter is listed FIRST", async () => {
		await sendPlanWelcomeEmail(sub([meter, flat]));
		expect(WelcomeToPlanEmail).toHaveBeenCalledWith(
			expect.objectContaining({ planName: "plan:enterprise" }),
		);
	});
});

describe("no licensed line at all", () => {
	it("falls back to metadata.plan and warns, never to the meter price", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		await sendSubscriptionCanceledEmail(sub([meter], { metadata: { plan: "enterprise" } }));
		expect(SubscriptionCanceledEmail).toHaveBeenCalledWith(
			expect.objectContaining({ planLabel: "plan:enterprise", accessUntilLabel: undefined }),
		);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("sub_1"));
		warn.mockRestore();
	});

	it("does not warn for a subscription that carries no items at all", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		await sendSubscriptionCanceledEmail(sub([], { metadata: { plan: "team" } }));
		expect(warn).not.toHaveBeenCalled();
		warn.mockRestore();
	});
});
