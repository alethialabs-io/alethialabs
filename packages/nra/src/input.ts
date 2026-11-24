// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The two JSON inputs of a month's NRA package, and the one of a single protocol. Nothing here reads
// a database or a secret: whoever runs the build (the console's `factura:export -- --nra`, or
// `nra:build` in the books workflow) hands over these files.
//
//  - facturi-M.json (SalesFile): the documents the company ISSUED in month M, фактури and credit
//    notes, each already classified (`treatment`). The console writes it from its `factura` table
//    (apps/console/lib/billing/nra/sales-documents.ts); the monthly Paddle фактура is one of them.
//  - nra-input.json (NraInput, version 2): what the console cannot know. The filer and the person
//    who files (DEKLAR 00-04, by ЕГН, so the file is personal data and stays out of the repository),
//    the registration (basis чл. 100, ал. 1 and its effective date), the VIES declarant, the
//    protocol series, and every document the company RECEIVED in M (`purchases`), each with the
//    treatment the books workflow or the accountant decided.
//  - purchase.json (ProtocolRequest): one reverse-charge purchase, for `nra:protocol`, which issues
//    its чл. 117 protocol on the day (the 15-day limit of чл. 117, ал. 3 ЗДДС).
//
// Amounts are decimal strings ("12.34", "-5"), parsed exactly to cents; never floats. Objects are
// strict: an unknown key (a typo, or the version-1 `stripe` block) is refused, not ignored.

import { z } from "zod";

/** A decimal amount with at most two places, signed: "12", "12.5", "-12.34". */
const amount = z
	.string()
	.regex(/^-?\d{1,12}(\.\d{1,2})?$/, 'an amount with at most two decimals, e.g. "12.34"');

/** YYYY-MM-DD. */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a date as YYYY-MM-DD");

/** EUR per one unit of the document currency, up to eight places ("0.95000000"). */
const eurRate = z.string().regex(/^\d{1,6}(\.\d{1,8})?$/, 'EUR per unit, e.g. "0.95000000"');

/** ISO 4217, upper-case. */
const currency = z.string().regex(/^[A-Z]{3}$/, "a three-letter currency code, e.g. USD");

/** ISO 3166-1 alpha-2, upper-case. */
const country = z.string().regex(/^[A-Z]{2}$/, "a two-letter country code, e.g. IE");

/** A protocol number of the company's own series: up to ten digits. */
const seriesNumber = z.string().regex(/^\d{1,10}$/, "up to ten digits");

/** The company's VAT number. */
const filerVat = z.string().regex(/^BG\d{9,10}$/, "BG followed by the 9- or 10-digit number");

/** How a document issued by the company is taxed, which decides its sales-journal cells. */
export const SALE_TREATMENTS = [
	/** Place of supply in Bulgaria, 20 % charged: 02-11 / 02-21. */
	"bg_vat_20",
	/** A service to a business in another member state, чл. 21, ал. 2 ЗДДС, reverse charge: 02-17, VIES. */
	"eu_b2b_services_21_2",
	/** A supply with its place outside the EU (Paddle.com Market Ltd, Paddle.com Inc.), credit under чл. 69, ал. 2: 02-18. */
	"outside_eu_69_2",
] as const;

/** How a document received by the company is treated, which decides its journal cells. */
export const PURCHASE_TREATMENTS = [
	/** A service from a supplier not established in Bulgaria, tax due by us (чл. 82, ал. 2): a чл. 117 protocol, 02-26/02-22 and 03-31/03-41. */
	"rc_services_82_2",
	/** A Bulgarian supplier's фактура with VAT, full credit (чл. 69, ал. 1, т. 1): 03-31/03-41. */
	"bg_vat_full_credit",
	/** A Bulgarian supplier's фактура with VAT and no credit (чл. 70): 03-30, base plus tax. */
	"bg_vat_no_credit",
	/** In neither journal (an exempt financial service such as Stripe's card-processing fee): listed in the summary only. */
	"outside_journal",
] as const;

/** A party of a received document. */
const supplierSchema = z.strictObject({
	/** The legal name as on its document. */
	name: z.string().min(1),
	country,
	/** Its VAT number with prefix, as on its document; null when it has none. */
	vatNumber: z.string().min(4).nullable(),
});

/** One document received in the month. */
const purchaseSchema = z.strictObject({
	supplier: supplierSchema,
	/** A фактура, or a credit note correcting one (amounts negative). */
	kind: z.enum(["invoice", "credit_note"]).default("invoice"),
	/** The supplier's document number. */
	documentNumber: z.string().min(1),
	documentDate: isoDate,
	/** The date the tax became chargeable (чл. 25 ЗДДС); decides the month. */
	taxEventDate: isoDate,
	/** What it is, for the protocol and the journals ("Amazon Web Services, usage 2026-12"). */
	description: z.string().min(1),
	currency,
	/** The taxable amount in the document currency, net of tax. Negative on a credit note. */
	amount,
	/** EUR per unit of `currency` (the ECB rate of чл. 26, ал. 6 ЗДДС); null for EUR. */
	eurRate: eurRate.nullable(),
	/** The taxable amount in euro: `amount` × `eurRate`, rounded half away from zero. */
	netEur: amount,
	/** The VAT on the document in euro: required for a Bulgarian supplier's фактура; for a reverse charge it must equal 20 % of netEur when given. */
	vatEur: amount.optional(),
	treatment: z.enum(PURCHASE_TREATMENTS),
	/** The protocol's number, when already issued (by `nra:protocol`) or taken from a shared series. */
	protocolNumber: seriesNumber.optional(),
	/** The protocol's date, when already issued. */
	protocolDate: isoDate.optional(),
});

/** The operator's input file, version 2 (full VAT under чл. 100, ал. 1). */
export const nraInputSchema = z.strictObject({
	version: z.literal(2),
	filer: z.strictObject({
		/** The company's VAT number, "BG" + ЕИК, as the NRA registered it. */
		vatNumber: filerVat,
		/** DEKLAR 00-04, "Лице, подаващо данните (ЕГН/име)". */
		submitter: z.string().min(1),
	}),
	registration: z.strictObject({
		/** The registration basis. Only чл. 100, ал. 1 (voluntary, full VAT) is built. */
		basis: z.literal("chl100"),
		/** The day the registration act was served (чл. 103, т. 3 ЗДДС). Documents with an earlier tax event are left out. */
		effectiveDate: isoDate,
	}),
	vies: z
		.strictObject({
			declarant: z.strictObject({
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
	protocols: z.strictObject({
		/** "own": a separate ten-digit series; "shared_with_factura": numbers from the фактура series, so each protocol's number is given. */
		series: z.enum(["own", "shared_with_factura"]),
		/** Own series: the number of the first protocol this build numbers (the last issued, plus one). */
		firstNumber: z.number().int().min(1).max(9_999_999_999).optional(),
		/** One issue date for every protocol this build dates; by default each is dated as the rules allow. */
		issueDate: isoDate.optional(),
	}),
	deklar: z
		.strictObject({
			/** Refundable VAT of earlier periods (their 01-80) set off against this period's 01-50 under чл. 92, ал. 1: written in 01-70. */
			refundOffsetEur: amount.optional(),
		})
		.optional(),
	purchases: z.array(purchaseSchema).default([]),
});

/** One document issued by the company in the month. */
const salesDocumentSchema = z.strictObject({
	kind: z.enum(["invoice", "credit_note"]),
	/** The ten-digit number. */
	number: z.string().regex(/^\d{10}$/, "the ten-digit document number"),
	issueDate: isoDate,
	/** The date of the chargeable event (чл. 25 ЗДДС). */
	chargeableDate: isoDate,
	recipient: z.strictObject({
		name: z.string().min(1),
		country,
		/** Its VAT number with prefix, when it has one. */
		vatNumber: z.string().min(4).nullable(),
		/** A Bulgarian recipient's ЕИК (or ЕГН) when it has no VAT number. */
		localId: z.string().min(1).nullable().default(null),
	}),
	/** The service, for the journal's 30 characters. */
	description: z.string().min(1),
	treatment: z.enum(SALE_TREATMENTS),
	currency,
	/** The taxable amount in the document currency. Negative on a credit note. */
	amount,
	/** EUR per unit of `currency`; null for EUR. */
	eurRate: eurRate.nullable(),
	/** The taxable amount in euro. */
	netEur: amount,
	/** The VAT charged in euro; "0" outside bg_vat_20. */
	vatEur: amount,
	/** For a credit note: the фактура it corrects. */
	original: z.strictObject({ number: z.string().min(1), issueDate: isoDate }).nullable().default(null),
});

/** facturi-M.json: the month's issued documents. */
export const salesFileSchema = z.strictObject({
	version: z.literal(1),
	/** YYYY-MM. */
	month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "a month as YYYY-MM"),
	documents: z.array(salesDocumentSchema),
});

/** purchase.json of `nra:protocol`: one reverse-charge purchase. */
export const protocolRequestSchema = z.strictObject({
	version: z.literal(2),
	filer: z.strictObject({ vatNumber: filerVat }),
	purchase: purchaseSchema,
	/** The protocol's date; the earlier of the tax event plus 15 days and today when not given. */
	issueDate: isoDate.optional(),
});

/** The parsed input file. */
export type NraInput = z.infer<typeof nraInputSchema>;
/** The input file as written, before defaults. */
export type NraInputFile = z.input<typeof nraInputSchema>;
/** One supplier, as the input file names it. */
export type NraSupplier = z.infer<typeof supplierSchema>;
/** One received document. */
export type NraPurchase = z.infer<typeof purchaseSchema>;
/** A received document's treatment. */
export type PurchaseTreatment = (typeof PURCHASE_TREATMENTS)[number];
/** The parsed facturi-M.json. */
export type SalesFile = z.infer<typeof salesFileSchema>;
/** facturi-M.json as written, before defaults. */
export type SalesFileInput = z.input<typeof salesFileSchema>;
/** One issued document. */
export type SalesDocument = z.infer<typeof salesDocumentSchema>;
/** An issued document's treatment. */
export type SaleTreatment = (typeof SALE_TREATMENTS)[number];
/** The parsed purchase.json. */
export type ProtocolRequest = z.infer<typeof protocolRequestSchema>;

/** A decimal amount ("12.34", "-5", "0.5") as integer cents, exactly. */
export function toCents(value: string): number {
	const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value);
	if (!m) throw new Error(`"${value}" is not an amount`);
	const cents = Number(m[2]) * 100 + Number((m[3] ?? "").padEnd(2, "0"));
	return m[1] === "-" ? -cents : cents;
}

/** The result of parsing a JSON input: the value, or every problem with its path. */
export type Parsed<T> = { ok: true; value: T } | { ok: false; problems: string[] };

/** Validates `raw` against `schema`; the problems name each path. */
function validate<T>(schema: z.ZodType<T>, raw: unknown): Parsed<T> {
	const parsed = schema.safeParse(raw);
	if (parsed.success) return { ok: true, value: parsed.data };
	return { ok: false, problems: parsed.error.issues.map((i) => `${i.path.join(".") || "(file)"}: ${i.message}`) };
}

/** Parses `json` against `schema`. */
function parseWith<T>(schema: z.ZodType<T>, json: string): Parsed<T> {
	let raw: unknown;
	try {
		raw = JSON.parse(json);
	} catch (err) {
		return { ok: false, problems: [`not JSON: ${err instanceof Error ? err.message : String(err)}`] };
	}
	return validate(schema, raw);
}

/** Parses nra-input.json. */
export function parseNraInput(json: string): Parsed<NraInput> {
	return parseWith(nraInputSchema, json);
}

/** Parses facturi-M.json. */
export function parseSalesFile(json: string): Parsed<SalesFile> {
	return parseWith(salesFileSchema, json);
}

/** Parses purchase.json of `nra:protocol`. */
export function parseProtocolRequest(json: string): Parsed<ProtocolRequest> {
	return parseWith(protocolRequestSchema, json);
}

/** Validates an already-built input object (the console's fixtures and its own projections). */
export function checkNraInput(raw: unknown): Parsed<NraInput> {
	return validate(nraInputSchema, raw);
}

/** Validates an already-built facturi-M object. */
export function checkSalesFile(raw: unknown): Parsed<SalesFile> {
	return validate(salesFileSchema, raw);
}
