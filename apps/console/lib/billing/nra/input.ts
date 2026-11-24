// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The operator's input file for the NRA package (#7457): what the console cannot read from its own
// tables. It is a small JSON file the operator keeps outside the repository (it names the person who
// files, by ЕГН, so it is personal data), passed to `factura:export -- --nra=<file>`.
//
// What it carries, and why each part is not derived:
//  - filer: the company's VAT number once registered, and the person who files (DEKLAR 00-04).
//  - vies: the declarant and the correspondence address of the VIES declaration (Appendix 15,
//    sections "Декларатор" and "Регистрирано лице"). Needed only in months with EU B2B sales.
//  - protocols: where this month's чл. 117 protocol numbers start. The series runs across months and
//    nothing in the database records it yet, so the operator states it, and the generator refuses
//    to guess it.
//  - stripe: who Stripe is for the protocol (its legal entity and VAT number, from its tax invoice)
//    and the accountant's decision on the card-processing fee: exempt under чл. 46, ал. 1, т. 3 ЗДДС
//    or taxable (research/stripe-fees-art97a.md §8). With processing fees present and no decision,
//    the generator refuses.
//  - purchases: every other foreign service invoiced to the company in the month (Google Workspace,
//    AWS, Anthropic …): supplier, country, VAT number, document number and date, net EUR.
//
// Amounts are decimal strings in euro ("12.34"), parsed exactly to cents; never floats.

import { z } from "zod";

/** A decimal euro amount with at most two places, as written by a person: "12", "12.5", "12.34". */
const eurAmount = z
	.string()
	.regex(/^-?\d{1,12}(\.\d{1,2})?$/, "an amount in euro with at most two decimals, e.g. \"12.34\"");

/** YYYY-MM-DD. */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a date as YYYY-MM-DD");

/** A supplier of a reverse-charge service. */
const supplierSchema = z.object({
	/** The legal name as on its invoice. */
	name: z.string().min(1),
	/** ISO 3166-1 alpha-2 of the country it supplies from. */
	country: z.string().regex(/^[A-Z]{2}$/, "a two-letter country code, e.g. IE"),
	/** Its VAT number with prefix, as on its invoice; null when it has none (a non-EU supplier). */
	vatNumber: z.string().min(4).nullable(),
});

/** One foreign service invoice received in the month. */
const purchaseSchema = z.object({
	supplier: supplierSchema,
	/** The supplier's invoice number. */
	documentNumber: z.string().min(1),
	/** The supplier's invoice date. */
	documentDate: isoDate,
	/** The date the tax became chargeable (чл. 25 ЗДДС); the invoice date when not given. */
	taxEventDate: isoDate.optional(),
	/** What the service is, for the protocol and the journals ("Google Workspace Business Starter"). */
	description: z.string().min(1),
	/** The taxable amount in euro, net of any tax the supplier showed. */
	netEur: eurAmount,
});

/** The whole input file. */
export const nraInputSchema = z.object({
	filer: z.object({
		/** The company's VAT number, "BG" + ЕИК, as the NRA registered it. */
		vatNumber: z.string().regex(/^BG\d{9,10}$/, "BG followed by the 9- or 10-digit number"),
		/** DEKLAR 00-04, "Лице, подаващо данните (ЕГН/име)". */
		submitter: z.string().min(1),
	}),
	vies: z
		.object({
			declarant: z.object({
				/** ЕГН/ЛНЧ/служебен номер (VDR.2). */
				personalId: z.string().regex(/^\d{10}$/, "a 10-digit ЕГН or ЛНЧ"),
				/** The declarant's three names (VDR.3). */
				name: z.string().min(1),
				city: z.string().min(1),
				postcode: z.string().regex(/^\d{4}$/, "a 4-digit postcode"),
				address: z.string().min(1),
				/** A: an authorised agent (пълномощник); R: the company's representative. */
				capacity: z.enum(["A", "R"]),
			}),
			/** The company's correspondence address (VTR.4). */
			correspondenceAddress: z.string().min(1),
		})
		.optional(),
	protocols: z.object({
		/** The number of this month's first чл. 117 protocol: the last one issued, plus one. */
		firstNumber: z.number().int().min(1).max(9_999_999_999),
		/** The protocols' issue date; the last day of the month when not given. */
		issueDate: isoDate.optional(),
	}),
	stripe: z
		.object({
			supplier: supplierSchema,
			/** The accountant's treatment of the card-processing fee. */
			processingFees: z.enum(["taxable", "exempt"]),
			/** Stripe's monthly tax invoice for its fees, when issued by the protocol date. */
			documentNumber: z.string().min(1).optional(),
			documentDate: isoDate.optional(),
		})
		.optional(),
	purchases: z.array(purchaseSchema).default([]),
});

/** The parsed input file. */
export type NraInput = z.infer<typeof nraInputSchema>;
/** One supplier, as the input file names it. */
export type NraSupplier = z.infer<typeof supplierSchema>;
/** One purchase, as the input file names it. */
export type NraPurchaseInput = z.infer<typeof purchaseSchema>;

/** A decimal euro amount ("12.34", "-5", "0.5") as integer cents, exactly. */
export function eurToCents(amount: string): number {
	const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(amount);
	if (!m) throw new Error(`"${amount}" is not a euro amount`);
	const cents = Number(m[2]) * 100 + Number((m[3] ?? "").padEnd(2, "0"));
	return m[1] === "-" ? -cents : cents;
}

/** Parses the input file's JSON text; the error lists every problem with its path. */
export function parseNraInput(json: string): { ok: true; input: NraInput } | { ok: false; problems: string[] } {
	let raw: unknown;
	try {
		raw = JSON.parse(json);
	} catch (err) {
		return { ok: false, problems: [`not JSON: ${err instanceof Error ? err.message : String(err)}`] };
	}
	const parsed = nraInputSchema.safeParse(raw);
	if (parsed.success) return { ok: true, input: parsed.data };
	return { ok: false, problems: parsed.error.issues.map((i) => `${i.path.join(".") || "(file)"}: ${i.message}`) };
}
