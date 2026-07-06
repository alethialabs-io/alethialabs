// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The tax-id types offered in the checkout form's "Tax ID" dropdown. A curated subset
// of Stripe's tax id types (the common B2B ones); the value is the Stripe `type` passed
// straight to `customers.createTaxId`. `TaxIdType` is a narrowing of Stripe's union, so
// it's assignable to the SDK param without a cast. Pure data — safe to import in client
// components and server actions alike.

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
