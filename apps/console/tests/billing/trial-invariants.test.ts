// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The cardless Pro trial, pinned (#2372).
//
// The trial was correct before this PR and the requirement is to PRESERVE it exactly. That is a
// harder thing to guarantee than to build: the change that breaks it will not be a change to the
// trial, it will be a change to the paid-conversion gate that quietly starts applying to it. A
// paywall in front of the free trial would be a straightforward product regression AND a false
// statement on the pricing page.
//
// So these read the source structurally, the same way the eligibility-coverage test does, and assert
// the four properties the product actually promises:
//
//   one per ACCOUNT · no card required · Community fallback · never deleted on expiry
//
// A behavioural test over a mocked Stripe would prove the current code path; it would not notice
// `startProTrial` gaining a `gatePaidConversion` call, which is the realistic way this breaks.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// The GATE is imported for real — not the action. What this file asserts about startProTrial is an
// ABSENCE ("it must not call the gate"), and an absence is only meaningful while the thing being
// absent exists: if `assertPaidConversionAllowed` were deleted, every check below would pass while
// proving nothing. Importing the action instead would drag the whole auth chain into a test that
// only reads text.
import { assertPaidConversionAllowed } from "@/lib/billing/eligibility";

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

describe("the cardless Pro trial", () => {
	const body = actionBody("startProTrial");

	it("the gate this trial must stay out of actually exists", () => {
		expect(typeof assertPaidConversionAllowed).toBe("function");
	});

	// THE regression this file exists to catch. The trial takes no money, so the paid-conversion gate
	// must not apply to it — and the gate is new, adjacent, and looks like it belongs everywhere.
	it("is NOT behind the paid-conversion gate", () => {
		// If this fails: the trial requires no card and takes no money. Gating it puts a paywall in
		// front of the free trial the pricing page promises, and refuses it outright in every market
		// that is not yet open.
		expect(body.includes("gatePaidConversion(")).toBe(false);
		expect(body.includes("assertPaidConversionAllowed(")).toBe(false);
	});

	// No card. `trial_period_days` with no payment method is the whole mechanism; a `payment_method`
	// or a SetupIntent here would make the trial card-gated without anyone calling it that.
	it("collects no payment method", () => {
		expect(body).toContain("trial_period_days: 30");
		expect(body.includes("default_payment_method")).toBe(false);
		expect(body.includes("setupIntents.create")).toBe(false);
		// Word-boundary anchored: a bare substring also matches `missing_payment_method`, which is the
		// trial's END behaviour and must stay.
		expect(/\bpayment_method:/.test(body)).toBe(false);
	});

	// One per ACCOUNT, not per org — otherwise spinning up organizations mints unlimited trials.
	// Both guards matter: the ledger flag, and the fallback for accounts that predate it.
	it("is one per account, with a fallback for a never-stamped ledger", () => {
		expect(body).toContain("proTrialConsumedAt");
		expect(body).toContain("accountHasLiveSubscription");
	});

	// The flag is burned only AFTER Stripe accepts, so a failed create does not silently consume the
	// user's single trial.
	it("burns the trial only after Stripe accepts it", () => {
		const created = body.indexOf("subscriptions.create");
		const burned = body.indexOf("proTrialConsumedAt: new Date()");
		expect(created).toBeGreaterThan(-1);
		expect(burned).toBeGreaterThan(-1);
		// Stamped before Stripe accepts, a failed create would consume the account's only trial.
		expect(burned).toBeGreaterThan(created);
	});

	// On a missing payment method at trial end Stripe CANCELS the subscription; the org falls back to
	// Community. `pause` would leave it in a state the entitlement seam reads as neither.
	it("ends by cancelling to the Community fallback, never by deleting anything", () => {
		expect(body).toContain('missing_payment_method: "cancel"');
		// An expired trial must leave the org and its data intact on Community, not remove them.
		expect(/\bdelete\b/i.test(body)).toBe(false);
	});
});
