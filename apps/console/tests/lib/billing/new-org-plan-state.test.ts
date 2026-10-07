// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #5522 — what a finished paid create-a-team setup may say about its plan. The sheet used to say
// "Subscription active" whatever Stripe said; the state is now decided from the subscription and its
// first invoice's payments, and only `active` is announced as active.

import { describe, expect, it } from "vitest";
import {
	actionNeededNextStep,
	NEW_ORG_PLAN_COPY,
	NEW_ORG_PLAN_STATES,
	newOrgPlanState,
} from "@/lib/billing/new-org-plan-state";

describe("newOrgPlanState", () => {
	it("a live subscription is active", () => {
		expect(newOrgPlanState("active", null)).toBe("active");
		expect(newOrgPlanState("trialing", null)).toBe("active");
	});

	it("an incomplete subscription whose payment SUCCEEDED is processing; one still IN FLIGHT is confirming", () => {
		expect(newOrgPlanState("incomplete", "succeeded")).toBe("processing");
		expect(newOrgPlanState("incomplete", "in_flight")).toBe("confirming");
	});

	it("an incomplete subscription whose payment awaits the customer or their bank needs action", () => {
		expect(newOrgPlanState("incomplete", "none")).toBe("action_needed");
		expect(newOrgPlanState("past_due", null)).toBe("action_needed");
	});

	it("a subscription closed before any money moved was not charged", () => {
		expect(newOrgPlanState("canceled", "none")).toBe("not_charged");
		expect(newOrgPlanState("incomplete_expired", "none")).toBe("not_charged");
	});

	it("a closed subscription is never called 'not charged' unless the payments read proved it", () => {
		expect(newOrgPlanState("canceled", "succeeded")).toBe("not_active");
		expect(newOrgPlanState("canceled", "in_flight")).toBe("not_active");
		expect(newOrgPlanState("canceled", "unrecognised")).toBe("not_active");
		expect(newOrgPlanState("canceled", null)).toBe("not_active");
		expect(newOrgPlanState("paused", null)).toBe("not_active");
	});

	it("a payments read that failed, or could not be understood, is unconfirmed — never 'processing'", () => {
		expect(newOrgPlanState("incomplete", null)).toBe("unconfirmed");
		expect(newOrgPlanState("incomplete", "unrecognised")).toBe("unconfirmed");
	});
});

describe("NEW_ORG_PLAN_COPY", () => {
	it("processing (the payment succeeded) may say it went through and the plan switches on", () => {
		const { sentence, toast } = NEW_ORG_PLAN_COPY.processing;
		expect(sentence).toMatch(/payment went through/);
		expect(toast).toMatch(/payment went through/);
		expect(`${sentence} ${toast}`).toMatch(/switches on in a moment/);
	});

	it("confirming (a payment still in flight, which can fail) claims nothing about the outcome", () => {
		const { sentence, toast } = NEW_ORG_PLAN_COPY.confirming;
		expect(sentence).toBe(
			"Your payment is being confirmed. Your team is on the free plan until it is; the Pro plan switches on if it completes.",
		);
		expect(`${sentence} ${toast}`).not.toMatch(/went through|succeeded|in a moment|nothing more/);
	});

	it("action needed names both causes it cannot tell apart — a declined card or a bank confirmation", () => {
		const { sentence } = NEW_ORG_PLAN_COPY.action_needed;
		expect(sentence).toMatch(/declined/);
		expect(sentence).toMatch(/confirm/);
		expect(sentence).not.toMatch(/usually/);
	});

	it("an unconfirmed payment says so, and never that there is nothing more to do", () => {
		const { sentence, toast } = NEW_ORG_PLAN_COPY.unconfirmed;
		expect(`${sentence} ${toast}`).toMatch(/couldn't confirm/);
		expect(`${sentence} ${toast}`).not.toMatch(/nothing more/);
	});

	it("action needed does not send the customer to Billing, which has nothing to finish it with", () => {
		const { sentence, toast } = NEW_ORG_PLAN_COPY.action_needed;
		expect(`${sentence} ${toast} ${actionNeededNextStep(null)} ${actionNeededNextStep("https://x")}`).not.toMatch(
			/Billing/,
		);
	});

	it("names the plan as Billing does (Pro), never 'Team plan'", () => {
		for (const state of NEW_ORG_PLAN_STATES) {
			const { sentence, toast } = NEW_ORG_PLAN_COPY[state];
			expect(`${sentence} ${toast}`).not.toMatch(/Team plan/);
		}
	});

	it("only the active state says the subscription is active", () => {
		for (const state of NEW_ORG_PLAN_STATES) {
			const { toast, sentence, label } = NEW_ORG_PLAN_COPY[state];
			const says = `${toast} ${sentence} ${label}`;
			expect(/subscription active|plan is active/i.test(says)).toBe(state === "active");
		}
	});

	it("no state promises 'won't be charged again', and only not_charged says 'not charged'", () => {
		for (const state of NEW_ORG_PLAN_STATES) {
			const { toast, sentence } = NEW_ORG_PLAN_COPY[state];
			expect(`${toast} ${sentence}`).not.toMatch(/charged (again|twice)/i);
			expect(/not charged/i.test(`${toast} ${sentence}`)).toBe(state === "not_charged");
		}
	});
});
