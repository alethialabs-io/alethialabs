// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The VAT numbers the journals and VIES print: one normal form with the member-state prefix VIES
// expects (EL for Greece), and the Appendix 12 code for a foreign person with no EU VAT number.

import { EU_MEMBER_STATES } from "@repo/legal/commerce";

/**
 * ППЗДДС Приложение № 12: 02-07 / 03-08 "задължително се попълват с код "999999999999999" в случаите,
 * когато контрагентът е чуждестранно лице …, което няма регистрация … или няма ДДС номер, с който
 * лицето е регистрирано за целите на ДДС в друга държава членка".
 */
export const NO_EU_VAT_ID = "999999999999999";

/** A VAT number made comparable: spaces, dots and dashes removed, upper-case, GR… written EL…. */
function compact(input: string): string {
	const c = input.replace(/[\s.-]/g, "").toUpperCase();
	return c.startsWith("GR") ? `EL${c.slice(2)}` : c;
}

/** True for an ISO country in the EU. */
export function isEuCountry(country: string): boolean {
	return EU_MEMBER_STATES.includes(country);
}

/**
 * The VIES form of `input` when it is a VAT number of the EU member state `country` (Greece: EL),
 * else null. A number of another state, or a non-EU number, is not that country's.
 */
export function euVatNumberOf(input: string, country: string): string | null {
	const c = compact(input);
	const prefix = country === "GR" ? "EL" : country;
	if (!isEuCountry(country)) return null;
	return new RegExp(`^${prefix}[0-9A-Z+*]{2,12}$`).test(c) ? c : null;
}
