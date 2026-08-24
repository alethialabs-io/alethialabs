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

import { and, eq } from "drizzle-orm";
import {
	type PayerCapacity,
	paidMarketEnabled,
} from "@repo/legal/commerce";
import { LEGAL_DOCUMENTS } from "@repo/legal/documents";
import { getServiceDb } from "@/lib/db";
import { legalAcceptance, organizationBilling } from "@/lib/db/schema";

/** Why a paid conversion was refused — a closed set, so callers can branch without parsing prose. */
export type PaidConversionRefusal =
	| "terms_not_accepted"
	| "capacity_not_declared"
	| "billing_country_missing"
	| "market_closed";

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
 * Refuses the sale unless every commercial precondition holds. Throws
 * PaidConversionNotAllowedError; returns nothing on success, so a caller cannot accidentally use a
 * truthy return as "allowed" while ignoring a rejection.
 *
 * The order of the checks is the order a user can act on them: accept the terms, tell us who you
 * are, tell us where you are, and only then do we say whether we can sell there. Leading with
 * `market_closed` would make the other three unreachable and every refusal look permanent.
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
	if (!paidMarketEnabled(country, ctx.capacity)) {
		throw new PaidConversionNotAllowedError(
			"market_closed",
			"Alethia is not yet able to sell to customers in this country in this capacity. " +
				"Community remains free and unlimited in time, and the Pro trial is unaffected. " +
				"Contact sales@alethialabs.io and we will tell you when it opens.",
		);
	}
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
): Promise<void> {
	const [row] = await getServiceDb()
		.select({
			capacity: organizationBilling.payerCapacity,
			billingCountry: organizationBilling.billingCountry,
		})
		.from(organizationBilling)
		.where(eq(organizationBilling.organizationId, organizationId))
		.limit(1);
	await assertPaidConversionAllowed({
		userId,
		organizationId,
		capacity: row?.capacity ?? null,
		billingCountry: row?.billingCountry ?? null,
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
