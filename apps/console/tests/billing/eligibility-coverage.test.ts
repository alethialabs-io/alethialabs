// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The guard that makes "route every paid conversion through ONE eligibility module" (#2372) stay
// true after this PR.
//
// The module itself is easy to write and easy to bypass: the next person who adds a way to take
// money will copy the nearest existing action, and the nearest existing action's compliance call is
// four lines below a comment they will not read. So this test reads billing.ts as TEXT and asserts
// the property structurally: every exported action that reaches Stripe's money APIs passes through
// the gate first.
//
// A source-text test is a blunt instrument, and it is the right one here precisely because it cannot
// be satisfied by mocking. A behavioural test proves the six actions we know about call the gate; it
// says nothing about the seventh, which is the only one that matters.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const BILLING_ACTIONS = join(
	process.cwd(),
	"app/server/actions/billing.ts",
);

/** Stripe calls that CREATE a charge, a subscription or a paid invoice — i.e. take money. */
const MONEY_CALLS = [
	"checkout.sessions.create",
	"subscriptions.create",
	"subscriptions.update",
	"paymentIntents.create",
	"invoices.create",
	"invoices.finalizeInvoice",
];

/** Either form of the gate: the shared helper, or a direct assert for the no-org-yet path. */
const GATE_CALLS = ["gatePaidConversion(", "assertPaidConversionAllowed("];

/**
 * Actions that touch a money API but are NOT conversions, with the reason each is exempt.
 *
 * An allow-list with reasons, not a filter: adding an entry is a deliberate, reviewable act, and the
 * reason has to survive someone reading it. Gating these would be actively wrong — refusing to let a
 * user CANCEL because their market is closed would trap them in a subscription.
 */
const EXEMPT: Record<string, string> = {
	startProTrial:
		"the cardless trial takes NO money — no card, no charge, and gating it would put a paywall in " +
		"front of the free trial the product promises. Its own invariants are tested in trial-invariants.test.ts.",
	cancelSubscription:
		"cancelling takes no money and must never be refused — a closed market must not trap a customer " +
		"in a subscription they want to end.",
	resumeSubscription:
		"un-scheduling a cancellation restores an EXISTING paid state; the conversion that created it " +
		"was gated. Refusing here would cancel someone by inaction.",
	setDefaultPaymentMethod:
		"changing which saved card is default moves no money. Its own precondition — a billing address " +
		"and current acceptance — is asserted in setup-intent-default.test.ts.",
	voidIncompleteSubscriptions:
		"cleans up never-paid subscriptions; it only ever cancels.",
	linkSubscriptionToNewOrg:
		"the SECOND half of a conversion that was already gated at createNewOrgSubscriptionIntent — it " +
		"writes metadata onto an existing subscription and takes no further money. Re-gating it would " +
		"strand a paid subscription that Stripe has already created, unlinked to any org. It is instead " +
		"where the declared payer facts are PERSISTED, which this test's first run is what uncovered.",
};

function readBillingSource(): string {
	return readFileSync(BILLING_ACTIONS, "utf8");
}

/** Splits the file into `name → body` for every exported async action. */
function exportedActions(src: string): Map<string, string> {
	const out = new Map<string, string>();
	const re = /^export async function (\w+)\(/gm;
	const starts: { name: string; index: number }[] = [];
	let m = re.exec(src);
	while (m) {
		starts.push({ name: m[1], index: m.index });
		m = re.exec(src);
	}
	for (let i = 0; i < starts.length; i++) {
		const end = i + 1 < starts.length ? starts[i + 1].index : src.length;
		out.set(starts[i].name, src.slice(starts[i].index, end));
	}
	return out;
}

describe("every paid conversion routes through the eligibility module", () => {
	const src = readBillingSource();
	const actions = exportedActions(src);

	// If the parser stops finding actions, every assertion below passes trivially. That is the
	// failure mode a source-text test has, so it is checked first.
	it("parses the action file", () => {
		expect(actions.size).toBeGreaterThan(10);
		expect(actions.has("createCheckoutSession")).toBe(true);
	});

	it("gates every exported action that reaches a Stripe money API", () => {
		const ungated: string[] = [];
		for (const [name, body] of actions) {
			if (name in EXEMPT) continue;
			const takesMoney = MONEY_CALLS.some((call) => body.includes(call));
			if (!takesMoney) continue;
			if (!GATE_CALLS.some((gate) => body.includes(gate))) ungated.push(name);
		}
		if (ungated.length > 0) {
			throw new Error(
				`These exported actions reach a Stripe money API without passing through the ` +
					`paid-conversion gate:\n\n  ${ungated.join("\n  ")}\n\n` +
					`Call \`await gatePaidConversion(actor)\` before the Stripe call, or — if the action ` +
					`genuinely takes no money — add it to EXEMPT in this file WITH the reason. Do not delete ` +
					`this test: it is the only thing standing between "one eligibility module" and six copies ` +
					`of a rule.`,
			);
		}
		expect(ungated).toEqual([]);
	});

	// The six known conversions, named. The structural check above would still pass if someone
	// renamed them all out of existence; this says which ones must keep existing and keep the gate.
	it("keeps the gate on each of the six known conversion paths", () => {
		for (const name of [
			"createCheckoutSession",
			"createSubscriptionIntent",
			"createAiSubscriptionIntent",
			"createNewOrgSubscriptionIntent",
			"createCreditPackIntent",
			"changeSubscriptionPlan",
		]) {
			const body = actions.get(name);
			if (!body) throw new Error(`${name} has disappeared from billing.ts`);
			if (!GATE_CALLS.some((gate) => body.includes(gate))) {
				throw new Error(`${name} no longer calls the paid-conversion gate`);
			}
			expect(body).toBeDefined();
		}
	});

	// The gate must run BEFORE the money call, not after it. A gate that throws once the subscription
	// exists leaves a real Stripe object behind and a user who was charged for a sale we then refused.
	it("gates before it charges, never after", () => {
		for (const [name, body] of actions) {
			if (name in EXEMPT) continue;
			const gateAt = Math.min(
				...GATE_CALLS.map((g) => {
					const i = body.indexOf(g);
					return i === -1 ? Number.POSITIVE_INFINITY : i;
				}),
			);
			if (!Number.isFinite(gateAt)) continue;
			const moneyAt = Math.min(
				...MONEY_CALLS.map((c) => {
					const i = body.indexOf(c);
					return i === -1 ? Number.POSITIVE_INFINITY : i;
				}),
			);
			if (!Number.isFinite(moneyAt)) continue;
			if (gateAt >= moneyAt) {
				throw new Error(
					`${name} calls Stripe before the eligibility gate — a refusal after the charge leaves a ` +
						`real Stripe object behind and a customer who paid for a sale we then declined.`,
				);
			}
			expect(gateAt).toBeLessThan(moneyAt);
		}
	});

	it("documents a reason for every exemption", () => {
		for (const [name, reason] of Object.entries(EXEMPT)) {
			if (reason.length <= 40) {
				throw new Error(`${name} is exempt with no meaningful reason`);
			}
			expect(reason.length).toBeGreaterThan(40);
		}
	});
});
