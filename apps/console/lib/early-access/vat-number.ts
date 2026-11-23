// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The VAT number as an Early Access request carries it (EA-3, #7325): one normal form, the member
// state it belongs to, and the eligibility question asked of the EA-1 rule.
//
// Pure functions only, so the client form and the server action parse a number the same way and a
// test can pin both without a database.

import {
	EU_MEMBER_STATES,
	SELLER_COUNTRY,
	complimentaryGrantEligible,
} from "@repo/legal/commerce";

/** A parsed EU VAT number. */
export interface ParsedVatNumber {
	/** ISO 3166-1 alpha-2 country, as the rest of the product stores it (`GR`, never `EL`). */
	readonly country: string;
	/** The two-letter prefix VIES expects (`EL` for Greece, otherwise the country). */
	readonly viesCountryCode: string;
	/** The number without its prefix, upper-case, with spaces, dots and dashes removed. */
	readonly number: string;
	/** Prefix plus number, the form stored on the request (`DE123456789`). */
	readonly normalised: string;
}

/** Why a VAT number cannot be used for an Early Access request. */
export type VatNumberRefusal = "format" | "not_eu" | "seller_country";

/** The result of parsing: the number, or the reason it was refused. */
export type VatNumberParse =
	| { readonly ok: true; readonly vat: ParsedVatNumber }
	| { readonly ok: false; readonly reason: VatNumberRefusal };

/** The sentence a person is shown for each refusal. */
export const VAT_NUMBER_REFUSAL_MESSAGES: Readonly<Record<VatNumberRefusal, string>> = {
	format:
		"Enter the full VAT number with its two-letter country prefix, for example DE123456789.",
	not_eu: "The VAT number must be from an EU member state.",
	seller_country:
		"Organizations in Bulgaria can buy a plan directly; the complimentary grant is for EU businesses outside Bulgaria.",
};

/**
 * Parses a VAT number as typed. The prefix decides the member state; Greece's VAT prefix `EL` maps
 * to its country code `GR` (and `GR…` is accepted and stored as `EL…`). A Bulgarian number is refused because that cell is an ordinary sale, and
 * any non-EU prefix is refused because the grant exists only for the EU reverse-charge case.
 */
export function parseVatNumber(input: string): VatNumberParse {
	const compact = input.replace(/[\s.\-]/g, "").toUpperCase();
	const match = /^([A-Z]{2})([0-9A-Z+*]{2,12})$/.exec(compact);
	if (!match) return { ok: false, reason: "format" };
	const [, prefix, number] = match;
	// A Greek number typed with the country code (`GR…`) is the same number as its VAT form (`EL…`).
	const country = prefix === "EL" ? "GR" : prefix;
	const viesCountryCode = country === "GR" ? "EL" : country;
	if (!EU_MEMBER_STATES.includes(country)) return { ok: false, reason: "not_eu" };
	if (country === SELLER_COUNTRY) return { ok: false, reason: "seller_country" };
	return {
		ok: true,
		vat: { country, viesCountryCode, number, normalised: `${viesCountryCode}${number}` },
	};
}

/**
 * Whether an organization with this VAT number may ask for the complimentary grant today. The answer
 * is EA-1's `complimentaryGrantEligible`, asked as an `organization` that GAVE a VAT number: a VAT
 * number is a business's, and the request form is filed by the organization's billing admin.
 *
 * @param vatRegistered in production, `LEGAL_ENTITY.vatRegistered`. Once the seller is registered the
 *   grant closes and the organization buys like any other.
 */
export function grantEligibleFor(vat: ParsedVatNumber, vatRegistered: boolean): boolean {
	return complimentaryGrantEligible(vat.country, "organization", true, vatRegistered);
}
