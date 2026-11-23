// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The tax-id types offered in the checkout form's "Tax ID" dropdown. A curated subset
// of Stripe's tax id types (the common B2B ones); the value is the Stripe `type` passed
// straight to `customers.createTaxId`. `TaxIdType` is a narrowing of Stripe's union, so
// it's assignable to the SDK param without a cast. Pure data — safe to import in client
// components and server actions alike. Also the VAT-number format rules and the US state
// list the payer declaration asks for (#7324).

/** Stripe tax-id `type` values we expose in the UI (subset of Stripe's full union). */
export type TaxIdType =
	| "eu_vat"
	| "gb_vat"
	| "ch_vat"
	| "no_vat"
	| "us_ein"
	| "ca_gst_hst"
	| "au_abn"
	| "nz_gst"
	| "sg_gst"
	| "in_gst"
	| "ae_trn";

export interface TaxIdOption {
	value: TaxIdType;
	label: string;
	/** An example value, shown as the input placeholder so the format is obvious. */
	example: string;
}

/** The dropdown options (label shown to the user → Stripe type). `eu_vat` is default. */
export const TAX_ID_TYPES: TaxIdOption[] = [
	{ value: "eu_vat", label: "EU VAT number", example: "DE123456789" },
	{ value: "gb_vat", label: "UK VAT number", example: "GB123456789" },
	{ value: "ch_vat", label: "Switzerland VAT", example: "CHE-123.456.789 MWST" },
	{ value: "no_vat", label: "Norway VAT", example: "123456789MVA" },
	{ value: "us_ein", label: "US EIN", example: "12-3456789" },
	{ value: "ca_gst_hst", label: "Canada GST/HST", example: "123456789RT0001" },
	{ value: "au_abn", label: "Australia ABN", example: "12345678912" },
	{ value: "nz_gst", label: "New Zealand GST", example: "123456789" },
	{ value: "sg_gst", label: "Singapore GST", example: "M12345678X" },
	{ value: "in_gst", label: "India GST", example: "12ABCDE3456FGZH" },
	{ value: "ae_trn", label: "UAE TRN", example: "123456789012345" },
];

/** Look up a tax-id option by its Stripe type. */
export function taxIdOption(type: TaxIdType): TaxIdOption {
	return TAX_ID_TYPES.find((t) => t.value === type) ?? TAX_ID_TYPES[0];
}

/** Default tax-id type for the dropdown. */
export const DEFAULT_TAX_ID_TYPE: TaxIdType = "eu_vat";

// ── VAT numbers (#7324, Early Access) ─────────────────────────────────────────────────────────

/**
 * The tax-id types that ARE a VAT (or GST / TRN) registration number, as opposed to a business or
 * employer number (`us_ein`). An organization that declared "no VAT number" records none of these:
 * the declaration and the customer's tax ids must never disagree about whether one was given.
 */
const VAT_TAX_ID_TYPES: readonly TaxIdType[] = [
	"eu_vat",
	"gb_vat",
	"ch_vat",
	"no_vat",
	"ca_gst_hst",
	"nz_gst",
	"sg_gst",
	"in_gst",
	"ae_trn",
];

/** Whether a tax-id type is a VAT-kind registration number (see `VAT_TAX_ID_TYPES`). */
export function isVatTaxIdType(type: TaxIdType): boolean {
	return VAT_TAX_ID_TYPES.includes(type);
}

/**
 * The VAT-number prefix an EU member state's numbers carry. It is the country code everywhere except
 * Greece, whose VAT prefix is `EL` while its ISO code is `GR`.
 */
export function vatPrefixFor(country: string): string {
	const iso = country.trim().toUpperCase();
	return iso === "GR" ? "EL" : iso;
}

/** A VAT number split into its prefix and national part, plus the canonical `PREFIX+number` form. */
export interface NormalisedVatNumber {
	/** The VAT prefix (`DE`, `EL`, …). */
	readonly prefix: string;
	/** The national part, upper-case, with spaces, dots and hyphens removed. */
	readonly number: string;
	/** `prefix + number` — the form stored and sent to Stripe as an `eu_vat` value. */
	readonly full: string;
}

/**
 * Normalises an EU VAT number typed for `country`, or returns null when it cannot be one.
 *
 * Spaces, dots and hyphens are dropped and letters upper-cased. A leading prefix is accepted only when
 * it is THIS country's (a German organization cannot give a French number); without one, the country's
 * prefix is assumed. The national part must be 2–12 letters or digits, and for Bulgaria — the seller's
 * own country, where the number goes on the invoice — 9 or 10 digits. This is a FORMAT check: whether
 * the number is registered is VIES's question (`lib/billing/vies.ts`).
 */
export function normaliseEuVatNumber(
	country: string,
	raw: string,
): NormalisedVatNumber | null {
	const prefix = vatPrefixFor(country);
	const compact = raw.replace(/[\s.\-]/g, "").toUpperCase();
	if (compact.length === 0) return null;
	const hasLetterPrefix = /^[A-Z]{2}/.test(compact);
	let number = compact;
	if (hasLetterPrefix) {
		if (!compact.startsWith(prefix)) return null;
		number = compact.slice(prefix.length);
	}
	if (!/^[0-9A-Z]{2,12}$/.test(number)) return null;
	if (prefix === "BG" && !/^\d{9,10}$/.test(number)) return null;
	return { prefix, number, full: `${prefix}${number}` };
}

// ── US states ─────────────────────────────────────────────────────────────────────────────────

/** One USPS state code with its name, for the state picker. */
export interface UsStateOption {
	readonly code: string;
	readonly name: string;
}

/**
 * The 50 states, DC and Puerto Rico — the same 52 codes `@repo/legal/thresholds` keys its per-state
 * thresholds on, so every code the picker offers is one the purchase gate can count. A US buyer must
 * give one before any charge (#7324): a sale that cannot be attributed to a state cannot be counted
 * against any threshold.
 */
export const US_STATES: readonly UsStateOption[] = [
	{ code: "AL", name: "Alabama" },
	{ code: "AK", name: "Alaska" },
	{ code: "AZ", name: "Arizona" },
	{ code: "AR", name: "Arkansas" },
	{ code: "CA", name: "California" },
	{ code: "CO", name: "Colorado" },
	{ code: "CT", name: "Connecticut" },
	{ code: "DE", name: "Delaware" },
	{ code: "DC", name: "District of Columbia" },
	{ code: "FL", name: "Florida" },
	{ code: "GA", name: "Georgia" },
	{ code: "HI", name: "Hawaii" },
	{ code: "ID", name: "Idaho" },
	{ code: "IL", name: "Illinois" },
	{ code: "IN", name: "Indiana" },
	{ code: "IA", name: "Iowa" },
	{ code: "KS", name: "Kansas" },
	{ code: "KY", name: "Kentucky" },
	{ code: "LA", name: "Louisiana" },
	{ code: "ME", name: "Maine" },
	{ code: "MD", name: "Maryland" },
	{ code: "MA", name: "Massachusetts" },
	{ code: "MI", name: "Michigan" },
	{ code: "MN", name: "Minnesota" },
	{ code: "MS", name: "Mississippi" },
	{ code: "MO", name: "Missouri" },
	{ code: "MT", name: "Montana" },
	{ code: "NE", name: "Nebraska" },
	{ code: "NV", name: "Nevada" },
	{ code: "NH", name: "New Hampshire" },
	{ code: "NJ", name: "New Jersey" },
	{ code: "NM", name: "New Mexico" },
	{ code: "NY", name: "New York" },
	{ code: "NC", name: "North Carolina" },
	{ code: "ND", name: "North Dakota" },
	{ code: "OH", name: "Ohio" },
	{ code: "OK", name: "Oklahoma" },
	{ code: "OR", name: "Oregon" },
	{ code: "PA", name: "Pennsylvania" },
	{ code: "PR", name: "Puerto Rico" },
	{ code: "RI", name: "Rhode Island" },
	{ code: "SC", name: "South Carolina" },
	{ code: "SD", name: "South Dakota" },
	{ code: "TN", name: "Tennessee" },
	{ code: "TX", name: "Texas" },
	{ code: "UT", name: "Utah" },
	{ code: "VT", name: "Vermont" },
	{ code: "VA", name: "Virginia" },
	{ code: "WA", name: "Washington" },
	{ code: "WV", name: "West Virginia" },
	{ code: "WI", name: "Wisconsin" },
	{ code: "WY", name: "Wyoming" },
];

/** Whether `code` is one of `US_STATES` (case-insensitive). */
export function isUsStateCode(code: string | null | undefined): boolean {
	if (!code) return false;
	const upper = code.trim().toUpperCase();
	return US_STATES.some((s) => s.code === upper);
}

/**
 * The route, under an organization (`globalHref(slug, …)`), where an EU business with a VAT number
 * requests complimentary Early Access instead of buying (EA-3, #7325). The purchase gate refuses such
 * a buyer with `complimentary_grant`, and every purchase sheet links here from that refusal.
 */
export const EARLY_ACCESS_REQUEST_PATH = "settings/billing/early-access";
