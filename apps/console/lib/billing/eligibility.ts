// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// THE single server-side gate every paid conversion passes through (#2372).
//
// Before this module there were six independent entry points to taking money — hosted Checkout, the
// embedded subscription intent, the AI subscription intent, the new-org subscription intent, the
// credit-pack intent and a plan change — and each carried its own ad-hoc preconditions (is there an
// org? is there already a subscription?). None asked the two questions that decide whether the sale
// is lawful at all: has this person accepted the current Terms, and may we sell into their market in
// the capacity they are buying as?
//
// Six copies of a compliance rule is zero copies of it, because the seventh entry point will not
// have one. So the rule lives here, `assertPaidConversionAllowed` is the only way through, and
// `tests/billing/eligibility-coverage.test.ts` reds if a new exported conversion action appears in
// billing.ts without calling it.
//
// FAIL-CLOSED everywhere. Every unknown — no acceptance row, no billing country, an unrecognised
// capacity, an empty PAID_MARKETS — refuses the sale. The failure mode of refusing a lawful sale is
// a support ticket; the failure mode of allowing an unlawful one is a regulator.
//
// ONE waiver, and only of the market check: `testModeMarketOpen` lets a Stripe TEST-mode console
// with the release gate's flag past `market_closed`, so the gate can exercise the real checkout
// (#5412). It cannot open a live sale — a live key refuses whatever the flag says.

import { and, eq } from "drizzle-orm";
import {
	anyPaidMarketOpen,
	complimentaryGrantEligible,
	type PayerCapacity,
	paidMarketEnabled,
	vatIdGivenOf,
	vatIdStatusRequired,
} from "@repo/legal/commerce";
import { LEGAL_DOCUMENTS } from "@repo/legal/documents";
import { LEGAL_ENTITY } from "@repo/legal/entity";
import { usStateThreshold } from "@repo/legal/thresholds";
import { stripeSecretKey } from "@/lib/billing/stripe-key";
import { crossedThresholds, type SaleAmount } from "@/lib/billing/turnover";
import { getServiceDb } from "@/lib/db";
import { legalAcceptance, organizationBilling } from "@/lib/db/schema";

/**
 * Why a paid conversion was refused — a closed set, so callers can branch without parsing prose.
 *
 * The Early Access refusals (#7324):
 *  - `vat_status_not_declared` — an organization in an EU member state other than Bulgaria has not
 *    said whether it has a VAT number. The answer decides the paid-market cell, so it is not guessed.
 *  - `state_missing` — a US buyer gave no state (or one that is not a USPS code): the sale could not
 *    be counted against any state's threshold.
 *  - `complimentary_grant` — an EU business with a VAT number, while the seller is not VAT-registered.
 *    Selling to it needs an Art. 97a registration first; it is routed to the complimentary Early
 *    Access request (EA-3) instead. Callers link to `EARLY_ACCESS_REQUEST_PATH`.
 *  - `us_state_closed` — the buyer's US state's economic-nexus threshold would be reached by this sale.
 *  - `threshold_reached` — the Bulgarian registration threshold or the EU EUR 10,000 cross-border
 *    threshold would be crossed by this sale.
 */
export type PaidConversionRefusal =
	| "terms_not_accepted"
	| "capacity_not_declared"
	| "billing_country_missing"
	| "vat_status_not_declared"
	| "state_missing"
	| "complimentary_grant"
	| "market_closed"
	| "us_state_closed"
	| "threshold_reached";

/** A refusal carrying the reason and a message safe to show the user. */
export class PaidConversionNotAllowedError extends Error {
	readonly reason: PaidConversionRefusal;

	constructor(reason: PaidConversionRefusal, message: string) {
		super(message);
		this.name = "PaidConversionNotAllowedError";
		this.reason = reason;
	}
}

/** What the gate needs to know about the attempted purchase. */
export interface PaidConversionContext {
	readonly userId: string;
	readonly organizationId: string;
	/** Declared by the payer, never inferred from the shape of their address. */
	readonly capacity: PayerCapacity | null | undefined;
	/** ISO 3166-1 alpha-2. */
	readonly billingCountry: string | null | undefined;
	/**
	 * Whether an organization declared a VAT number: `true` given, `false` not given, `null`/omitted
	 * undeclared. Optional so callers written before #7324 still compile — and an omitted answer is
	 * UNDECLARED, which refuses an EU organization outside Bulgaria rather than guessing.
	 */
	readonly vatIdGiven?: boolean | null;
	/** USPS state code for a US buyer. Omitted or unknown refuses a US sale (`state_missing`). */
	readonly billingState?: string | null;
	/**
	 * What this sale charges, for the threshold check ("stop BEFORE the sale that crosses"). Omitted,
	 * the totals are read alone: a crossed threshold still refuses, only the last sale before it is
	 * not caught early.
	 */
	readonly sale?: SaleAmount | null;
}

/**
 * The document every user must have accepted before ANY use, paid or not.
 *
 * Derived from LEGAL_DOCUMENTS rather than hard-coded, so adding a second acceptance-required
 * document (a DPA, an AI addendum) extends the gate automatically instead of silently not applying.
 */
export function acceptanceRequiredDocuments() {
	return LEGAL_DOCUMENTS.filter((d) => d.acceptanceRequired);
}

/**
 * Whether this user has accepted the CURRENT version of every acceptance-required document.
 *
 * "Current version" and not "ever accepted": a new version is a new agreement, and treating an old
 * acceptance as covering it would be inventing consent — the same rule #2371 applied when it refused
 * to migrate a v1 consent cookie into v2.
 */
export async function hasAcceptedCurrentDocuments(
	userId: string,
): Promise<boolean> {
	const required = acceptanceRequiredDocuments();
	if (required.length === 0) return true;
	const db = getServiceDb();
	for (const doc of required) {
		const [row] = await db
			.select({ id: legalAcceptance.id })
			.from(legalAcceptance)
			.where(
				and(
					eq(legalAcceptance.userId, userId),
					eq(legalAcceptance.documentId, doc.id),
					eq(legalAcceptance.documentVersion, doc.version),
				),
			)
			.limit(1);
		if (!row) return false;
	}
	return true;
}

/**
 * The gate-only flag that opens the market check for a Stripe TEST-mode console (#5412).
 *
 * Set by `.github/workflows/release-gate.yml` on the legs that promise `stripe`, and nowhere else —
 * and that is enforced, not just stated: `scripts/check-billing-test-market-flag.mjs` (CI, the
 * `guards` job) fails when the name appears in any tracked file outside its short allowlist, which
 * covers every deploy workflow, `deploy/`, `infra/` and env assembly (#5443).
 */
export const TEST_MODE_MARKET_FLAG = "ALETHIA_BILLING_TEST_MARKET";

/**
 * Whether the `market_closed` check is waived because no real money can move (#5412).
 *
 * The release gate has to drive the real checkout — the subscription intent, Stripe.js's card
 * fields, the hosted Checkout session — or the day a market opens is the first day it runs.
 * `PAID_MARKETS` is empty and must stay empty, so the gate needs a second way past the market check
 * that cannot open a live sale. BOTH halves are required, and each one closes a different hole:
 *
 *  - the key must be a TEST secret (`sk_test_…`). A test-mode Stripe account cannot charge a card,
 *    so a sale this lets through is not a sale. A live key with the flag set — a copied env, a
 *    mistaken deploy — still refuses, which is the case the maintainer's ruling names.
 *  - the flag must be exactly "1". A test key alone is every sandbox env and every developer's
 *    `.env`; they keep measuring the product as it ships, refusals included.
 *
 * Only the MARKET check is waived. Terms acceptance, the payer's declared capacity and the billing
 * country are still asked first, so the gate run walks the same declaration a customer does.
 *
 * Read from `process.env` at call time, not at import, so a test can flip it between calls. That is
 * NOT what keeps it out of a client bundle, and an earlier version of this comment said it was:
 * Next inlines only `NEXT_PUBLIC_*` names (plus any listed under `next.config`'s `env`, which the
 * console does not use), so a server-only name such as this one is never baked in however it is
 * read. `scripts/check-billing-test-market-flag.mjs` fails if the name ever appears in
 * `next.config` or any other env assembly.
 *
 * The key is read through `stripeSecretKey`, the same accessor the Stripe client is built from, so
 * the key this waiver judges is the key that would move the money (#5443).
 */
export function testModeMarketOpen(
	env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
	const key = stripeSecretKey(env);
	return key.startsWith("sk_test_") && env[TEST_MODE_MARKET_FLAG] === "1";
}

/**
 * Whether Pro is on sale to ANYONE right now — the one question the upgrade sheet asks before it
 * shows the payer declaration (#6132, F030). With no cell open it opens on "Pro isn't on sale yet"
 * instead of a form whose every answer ends in `market_closed`.
 *
 * It reads the market through the SAME two inputs `assertPaidConversionAllowed` does — the cell
 * list and `testModeMarketOpen` — so the release gate, whose console carries the waiver, still sees
 * the declaration form and drives the real checkout. It is a global answer, not a per-payer one:
 * once any cell opens, a payer outside it walks the form and gets the gate's per-country refusal,
 * which remains the authority.
 */
export function paidSalesOpen(
	env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
	return anyPaidMarketOpen() || testModeMarketOpen(env);
}

/**
 * Refuses the sale unless every commercial precondition holds. Throws
 * PaidConversionNotAllowedError; returns nothing on success, so a caller cannot accidentally use a
 * truthy return as "allowed" while ignoring a rejection.
 *
 * The order of the checks is the order a user can act on them: accept the terms, tell us who you
 * are, tell us where you are (and, for an EU organization, whether it has a VAT number; for a US
 * buyer, which state), and only then do we say whether we can sell there. Leading with
 * `market_closed` would make the other checks unreachable and every refusal look permanent.
 *
 * `complimentary_grant` comes BEFORE the market: an EU business with a VAT number is not a buyer we
 * may sell to while unregistered, whatever the cells say, and it has somewhere to go today (EA-3).
 * The thresholds come AFTER it, and the test-mode waiver opens only the market check — a release gate
 * run still walks every Early Access refusal a customer would.
 */
export async function assertPaidConversionAllowed(
	ctx: PaidConversionContext,
): Promise<void> {
	if (!(await hasAcceptedCurrentDocuments(ctx.userId))) {
		throw new PaidConversionNotAllowedError(
			"terms_not_accepted",
			"Accept the current Terms of Service before subscribing.",
		);
	}
	if (ctx.capacity !== "consumer" && ctx.capacity !== "organization") {
		throw new PaidConversionNotAllowedError(
			"capacity_not_declared",
			"Tell us whether you are buying as an individual or on behalf of an organization — " +
				"the two carry different rights, so we cannot guess.",
		);
	}
	const country = ctx.billingCountry?.trim().toUpperCase() ?? "";
	if (country.length !== 2) {
		throw new PaidConversionNotAllowedError(
			"billing_country_missing",
			"Add a billing address before subscribing.",
		);
	}
	const vatIdGiven = ctx.capacity === "organization" ? (ctx.vatIdGiven ?? null) : null;
	if (vatIdGiven === null && vatIdStatusRequired(country, ctx.capacity)) {
		throw new PaidConversionNotAllowedError(
			"vat_status_not_declared",
			"Tell us whether the organization has a VAT number before subscribing.",
		);
	}
	const state = country === "US" ? normaliseState(ctx.billingState) : null;
	if (country === "US" && state === null) {
		throw new PaidConversionNotAllowedError(
			"state_missing",
			"Select the US state this purchase is billed in before subscribing.",
		);
	}
	if (
		complimentaryGrantEligible(country, ctx.capacity, vatIdGiven, LEGAL_ENTITY.vatRegistered)
	) {
		throw new PaidConversionNotAllowedError(
			"complimentary_grant",
			"Alethia cannot yet invoice a business in this country that has a VAT number. " +
				"Request complimentary Early Access instead: you get the plan with nothing to pay, " +
				"and nothing is ever charged for the free period.",
		);
	}
	if (!paidMarketEnabled(country, ctx.capacity, vatIdGiven) && !testModeMarketOpen()) {
		// No word about a trial (#5443), and none is true to add: the card-less trial (`startProTrial`)
		// passes this same gate (decision M12, #6907), so a closed market refuses it for this same
		// reason, and Hobby is the only thing a closed market leaves open.
		throw new PaidConversionNotAllowedError(
			"market_closed",
			"Alethia is not yet able to sell to customers in this country in this capacity. " +
				"Hobby stays free, with no time limit. " +
				"Contact sales@alethialabs.io and we will tell you when it opens.",
		);
	}
	const crossed = await crossedThresholds(
		{ country, capacity: ctx.capacity, vatIdGiven, state },
		ctx.sale ?? null,
	);
	if (crossed.some((c) => c.counter.id === "us_state")) {
		throw new PaidConversionNotAllowedError(
			"us_state_closed",
			"Alethia cannot take new purchases billed to this US state at the moment. " +
				"Hobby stays free. Contact sales@alethialabs.io and we will tell you when it reopens.",
		);
	}
	if (crossed.length > 0) {
		throw new PaidConversionNotAllowedError(
			"threshold_reached",
			"Alethia cannot take new purchases from this country at the moment. " +
				"Hobby stays free. Contact sales@alethialabs.io and we will tell you when it reopens.",
		);
	}
}

/** A USPS code the thresholds know, upper-case, or null — the same reading the gate counts by. */
function normaliseState(state: string | null | undefined): string | null {
	const code = state?.trim().toUpperCase() ?? "";
	return usStateThreshold(code) === null ? null : code;
}

/**
 * The gate for an EXISTING organization: reads the payer facts it declared, then applies the rule.
 *
 * This lives here rather than in the calling action so the module owns its own inputs. A caller that
 * assembled the context itself would be a second place where "which columns are the payer facts?"
 * is decided — and, more practically, a test that mocks this module would still be left with a
 * stray database read in the action, perturbing whatever else it had stubbed.
 */
export async function assertOrgPaidConversionAllowed(
	userId: string,
	organizationId: string,
	sale?: SaleAmount | null,
): Promise<void> {
	const [row] = await getServiceDb()
		.select({
			capacity: organizationBilling.payerCapacity,
			billingCountry: organizationBilling.billingCountry,
			vatIdStatus: organizationBilling.vatIdStatus,
			billingState: organizationBilling.billingState,
		})
		.from(organizationBilling)
		.where(eq(organizationBilling.organizationId, organizationId))
		.limit(1);
	await assertPaidConversionAllowed({
		userId,
		organizationId,
		capacity: row?.capacity ?? null,
		billingCountry: row?.billingCountry ?? null,
		vatIdGiven: vatIdGivenOf(row?.vatIdStatus),
		billingState: row?.billingState ?? null,
		sale: sale ?? null,
	});
}

/**
 * Whether a paid conversion would be allowed, without throwing — for rendering a disabled CTA and
 * an honest explanation rather than letting a user fill in a card form that will be refused.
 *
 * Deliberately a SECOND function over the same rule and not a separate implementation: it calls
 * `assertPaidConversionAllowed` and catches, so the UI can never disagree with the gate.
 */
export async function paidConversionStatus(
	ctx: PaidConversionContext,
): Promise<{ allowed: true } | { allowed: false; reason: PaidConversionRefusal; message: string }> {
	try {
		await assertPaidConversionAllowed(ctx);
		return { allowed: true };
	} catch (err) {
		if (err instanceof PaidConversionNotAllowedError) {
			return { allowed: false, reason: err.reason, message: err.message };
		}
		throw err;
	}
}
