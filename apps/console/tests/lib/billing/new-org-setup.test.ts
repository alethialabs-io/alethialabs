// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// ADR 0002 C106 (amendment 2026-10-14, S10b): the sentences for an ended setup live in ONE place, which
// the link (`refuseEndedLink`) and the resume lookup (`newOrgSetupStateFor`) both read.
//
// The expected sentences are the §5.5 rows of the ADR, written here as LITERALS. They are not imported
// from the module under test: a test that compares the module with itself cannot see the sentence
// change, nor the free-plan sentence printed twice.

import { describe, expect, it } from "vitest";
import { type EndedSetupRead, endedSetupClause, endedSetupRead } from "@/lib/billing/new-org-setup";
import { NEW_ORG_PLAN_STATES } from "@/lib/billing/new-org-plan-state";
import { PAYMENT_HOLD_RELEASE_REASONS, type PaymentHoldReleaseReason } from "@/lib/db/schema/payment-holds";

const NOT_CHARGED =
	"This checkout was closed before its payment completed, so it was not linked to a team. It was not charged.";
const UNCONFIRMED =
	"This checkout was closed, and we could not confirm whether its payment went through, so it was not linked to a team. Contact support at support@alethialabs.io with the time of the payment.";
const ALERT_RAISED = " We have raised an alert.";
const REFUNDED =
	"This checkout was closed, so it was not linked to a team. An earlier payment was refunded in full; it can take 5–10 business days to reach you.";
const FREE_PLAN = " A team already created for it stays on the Hobby plan.";

describe("C106: endedSetupRead", () => {
	const reasons: Array<PaymentHoldReleaseReason | null> = [...PAYMENT_HOLD_RELEASE_REASONS, null];

	for (const planState of NEW_ORG_PLAN_STATES) {
		for (const reason of reasons) {
			const expected =
				reason === "refunded" || reason === "already_refunded"
					? "refunded"
					: planState === "not_charged"
						? "not_charged"
						: "unconfirmed";
			it(`${planState} × ${reason ?? "no released hold"} reads ${expected}`, () => {
				expect(endedSetupRead(reason, planState)).toBe(expected);
			});
		}
	}

	it("covers both refund reasons, at least one other reason, and no released hold", () => {
		expect(reasons).toEqual(expect.arrayContaining(["refunded", "already_refunded", "voided_unpaid", null]));
	});
});

describe("C106: endedSetupClause", () => {
	it("not_charged: the §5.5 sentence, plus the free-plan sentence only when a team exists", () => {
		expect(endedSetupClause("not_charged", { alerted: false, teamExists: true })).toBe(`${NOT_CHARGED}${FREE_PLAN}`);
		expect(endedSetupClause("not_charged", { alerted: true, teamExists: true })).toBe(`${NOT_CHARGED}${FREE_PLAN}`);
		expect(endedSetupClause("not_charged", { alerted: false, teamExists: false })).toBe(NOT_CHARGED);
	});

	it("refunded: the §5.5 refund clause, plus the free-plan sentence only when a team exists", () => {
		expect(endedSetupClause("refunded", { alerted: false, teamExists: true })).toBe(`${REFUNDED}${FREE_PLAN}`);
		expect(endedSetupClause("refunded", { alerted: true, teamExists: true })).toBe(`${REFUNDED}${FREE_PLAN}`);
		expect(endedSetupClause("refunded", { alerted: false, teamExists: false })).toBe(REFUNDED);
	});

	it("unconfirmed: the alert sentence only when alerted, and the free-plan sentence only when a team exists", () => {
		expect(endedSetupClause("unconfirmed", { alerted: true, teamExists: true })).toBe(`${UNCONFIRMED}${ALERT_RAISED}${FREE_PLAN}`);
		expect(endedSetupClause("unconfirmed", { alerted: false, teamExists: true })).toBe(`${UNCONFIRMED}${FREE_PLAN}`);
		expect(endedSetupClause("unconfirmed", { alerted: true, teamExists: false })).toBe(`${UNCONFIRMED}${ALERT_RAISED}`);
		expect(endedSetupClause("unconfirmed", { alerted: false, teamExists: false })).toBe(UNCONFIRMED);
	});

	it("never prints the free-plan sentence twice", () => {
		const reads: EndedSetupRead[] = ["refunded", "not_charged", "unconfirmed"];
		for (const read of reads) {
			for (const alerted of [true, false]) {
				const clause = endedSetupClause(read, { alerted, teamExists: true });
				expect(clause.split("stays on the Hobby plan").length - 1).toBe(1);
			}
		}
	});
});
