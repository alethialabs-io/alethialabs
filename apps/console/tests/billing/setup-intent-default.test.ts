// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// "SetupIntent payment methods become usable defaults without bypassing billing-address and
// acceptance requirements" (#2372).
//
// The word doing the work is BYPASSING. Saving a card through a SetupIntent is a side door: it does
// not pass the checkout flow, so none of checkout's preconditions run — and the card it saves is
// exactly what every future OFF-SESSION renewal charges. A card promoted to default with no billing
// address and no current acceptance produces a renewal that nobody can justify, discovered months
// later with nobody present to fix it.
//
// Asserted structurally for the same reason as the eligibility coverage test: the realistic
// regression is someone simplifying `setDefaultPaymentMethod` back to a two-line Stripe update,
// which a mocked behavioural test would happily keep passing.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// The precondition is imported for real — not the action. The text scan asserts that
// setDefaultPaymentMethod CALLS `hasAcceptedCurrentDocuments`; that assertion is only worth
// something while the function it names exists, and importing the action itself would drag the whole
// auth chain into a test that only reads text.
import { hasAcceptedCurrentDocuments } from "@/lib/billing/eligibility";

const SRC = readFileSync(
	join(process.cwd(), "app/server/actions/billing.ts"),
	"utf8",
);

function actionBody(name: string): string {
	const start = SRC.indexOf(`export async function ${name}(`);
	if (start === -1) throw new Error(`${name} is gone from billing.ts`);
	const next = SRC.indexOf("\nexport async function ", start + 1);
	return SRC.slice(start, next === -1 ? SRC.length : next);
}

describe("promoting a saved card to the default", () => {
	const body = actionBody("setDefaultPaymentMethod");

	it("the acceptance precondition it scans for actually exists", () => {
		expect(typeof hasAcceptedCurrentDocuments).toBe("function");
	});

	it("requires current acceptance of the Terms", () => {
		// A removal here means future off-session renewals are charged with no agreement covering them.
		expect(body.includes("hasAcceptedCurrentDocuments(")).toBe(true);
	});

	it("requires a billing address, from the card or the customer", () => {
		expect(body).toContain("billing_details");
		expect(body).toContain("billingCountry");
		// Removing this leaves Stripe Tax with no place of supply, so the renewal it backs is raised
		// with the wrong tax or not at all.
		expect(body.includes("Add a billing address")).toBe(true);
	});

	// Without this, one org can promote another org's card by passing its id: `customers.update` does
	// not verify that the payment method belongs to the customer being updated.
	it("verifies the card belongs to this org's customer", () => {
		const retrieve = body.indexOf("paymentMethods.retrieve(");
		const update = body.indexOf("customers.update(");
		expect(retrieve).toBeGreaterThan(-1);
		// After the update, the foreign card is already the default — so the check must precede it.
		expect(retrieve).toBeLessThan(update);
		expect(body).toContain("Payment method not found.");
	});

	// Checks BEFORE the mutation, always: a throw after `customers.update` leaves the default already
	// changed, and the error tells the user it failed.
	it("runs every check before it mutates Stripe", () => {
		const firstCheck = body.indexOf("hasAcceptedCurrentDocuments(");
		const firstMutation = body.indexOf("customers.update(");
		expect(firstCheck).toBeLessThan(firstMutation);
	});
});

describe("saving a card", () => {
	const body = actionBody("createSetupIntent");

	// Collected WITH the card, at the only moment the user is present to type it.
	it("asks for strong authentication so the saved card can be charged off-session later", () => {
		expect(body).toContain("usage: \"off_session\"");
		expect(body).toContain("request_three_d_secure");
	});
});
