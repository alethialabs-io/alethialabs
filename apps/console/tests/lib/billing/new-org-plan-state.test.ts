// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #5522 — what a finished paid create-a-team setup may say about its plan. The sheet used to say
// "Subscription active" whatever Stripe said; the state is now decided from the subscription and its
// first invoice's payments, and only `active` is announced as active.

import { describe, expect, it } from "vitest";
import {
	NEW_ORG_PLAN_COPY,
	NEW_ORG_PLAN_STATES,
	newOrgPlanState,
} from "@/lib/billing/new-org-plan-state";

describe("newOrgPlanState", () => {
	it("a live subscription is active", () => {
		expect(newOrgPlanState("active", null)).toBe("active");
		expect(newOrgPlanState("trialing", null)).toBe("active");
	});

	it("an incomplete subscription whose payment succeeded or is in flight is processing", () => {
		expect(newOrgPlanState("incomplete", "succeeded")).toBe("processing");
		expect(newOrgPlanState("incomplete", "in_flight")).toBe("processing");
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

	it("an unread or unrecognised payment on an incomplete subscription claims only 'being confirmed'", () => {
		expect(newOrgPlanState("incomplete", null)).toBe("processing");
		expect(newOrgPlanState("incomplete", "unrecognised")).toBe("processing");
	});
});

describe("NEW_ORG_PLAN_COPY", () => {
	it("only the active state says the subscription is active", () => {
		for (const state of NEW_ORG_PLAN_STATES) {
			const { toast, sentence, label } = NEW_ORG_PLAN_COPY[state];
			const says = `${toast} ${sentence} ${label}`;
			if (state === "active") expect(says).toMatch(/active/i);
			else expect(says).not.toMatch(/subscription active|plan is active/i);
		}
	});

	it("no state promises 'won't be charged again', and only not_charged says 'not charged'", () => {
		for (const state of NEW_ORG_PLAN_STATES) {
			const { toast, sentence } = NEW_ORG_PLAN_COPY[state];
			expect(`${toast} ${sentence}`).not.toMatch(/charged (again|twice)/i);
			if (state !== "not_charged") expect(`${toast} ${sentence}`).not.toMatch(/not charged/i);
		}
	});
});
