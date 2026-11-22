// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The cardless Pro trial, pinned (#2372; decision M12, #6907).
//
// #2372 pinned the trial OUTSIDE the paid-conversion gate. Decision M12 (2026-11-17) reversed that:
// the trial is kept, card-less, but "the trial path must sit behind the same gate rules as paid", so a
// trial is refused for exactly the reasons a purchase is. This file now pins the reverse, plus the
// properties that did not change:
//
//   behind the gate · ceilings reserved before Stripe, given back on failure · one per ACCOUNT ·
//   no card required · Hobby fallback · never deleted on expiry
//
// These read the source structurally, the same way the eligibility-coverage test does: the realistic
// regression is a refactor that quietly drops the gate call, which a mocked-Stripe test would not see.
// The ceilings' own behaviour is tested in tests/lib/billing/trial.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// The GATE is imported for real — not the action. A presence check on its name is only meaningful
// while the thing named exists: if `assertOrgPaidConversionAllowed` were deleted, a body that still
// said `gatePaidConversion(` would prove nothing. Importing the action instead would drag the whole
// auth chain into a test that only reads text.
import { assertOrgPaidConversionAllowed } from "@/lib/billing/eligibility";

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

	it("the gate this trial passes actually exists", () => {
		expect(typeof assertOrgPaidConversionAllowed).toBe("function");
	});

	// Decision M12: the trial is refused for the same reasons a purchase is, and before Stripe is touched.
	it("passes the paid-conversion gate before any Stripe call", () => {
		const gate = body.indexOf("gatePaidConversion(");
		const created = body.indexOf("subscriptions.create");
		expect(gate).toBeGreaterThan(-1);
		expect(created).toBeGreaterThan(-1);
		expect(gate).toBeLessThan(created);
	});

	// The ceilings (one per organization, per person, per network) are spent before the mint, and given
	// back when no subscription was created — so a failed create does not consume a lifetime trial.
	it("reserves the trial ceilings before the mint and releases them when nothing was minted", () => {
		const reserved = body.indexOf("reserveTrial(");
		const created = body.indexOf("subscriptions.create");
		expect(reserved).toBeGreaterThan(-1);
		expect(reserved).toBeLessThan(created);
		expect(body).toContain("releaseTrial(reservation)");
		expect(body).toContain("if (!minted.done) await releaseTrial(reservation)");
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
	// Hobby (`community`). `pause` would leave it in a state the entitlement seam reads as neither.
	it("ends by cancelling to the Community fallback, never by deleting anything", () => {
		expect(body).toContain('missing_payment_method: "cancel"');
		// An expired trial must leave the org and its data intact on Community, not remove them.
		expect(/\bdelete\b/i.test(body)).toBe(false);
	});
});
