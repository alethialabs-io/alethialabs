// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// facturi-M.json: the month's фактури and credit notes as @repo/nra reads them (its SalesFile). The
// accountant's export writes this file beside the CSV, so the NRA package can be rebuilt from it
// alone with `nra:build` — in the books workflow, with no database and no secrets.
//
// THE TREATMENT each document gets, from what is printed on it (ЗДДС чл. 21, чл. 69, ал. 2):
//  - a Bulgarian recipient → bg_vat_20;
//  - a recipient in another member state with a VAT number of that state → eu_b2b_services_21_2
//    (чл. 21, ал. 2, reverse charge; VIES);
//  - a recipient in another member state with no such number (a consumer) → bg_vat_20: under the
//    EU-wide €10,000 threshold for electronically supplied services (Directive 2006/112/EC,
//    Art. 59c) the place of supply stays in Bulgaria. Card sales go through Paddle, the seller of
//    record, so a direct consumer фактура is rare; the accountant confirms the threshold;
//  - a recipient outside the EU (Paddle.com Market Ltd, UK; Paddle.com Inc., US) → outside_eu_69_2.
// The package re-checks each one (a bg_vat_20 document must carry 20 %; an EU B2B one, no VAT), so
// a document issued before the registration under the чл. 113, ал. 9 ground is not misfiled: its tax
// event precedes the effective date and it is left out of the journals.

import { checkSalesFile, euVatNumberOf, isEuCountry, type Parsed, type SalesDocument, type SalesFile, type SalesFileInput } from "@repo/nra";
import { minorToDecimal } from "@/lib/billing/factura/export";
import type { Factura } from "@/lib/db/schema";

/** The recipient's VAT number of `country` among the document's printed identifiers, or null. */
function vatNumberOf(doc: Factura, country: string): string | null {
	for (const id of doc.snapshot.recipient.identifiers) {
		const vat = euVatNumberOf(id.value, country);
		if (vat) return vat;
	}
	return null;
}

/** A Bulgarian recipient's ЕИК (9 or 13 digits) or ЕГН (10), when printed. */
function localIdOf(doc: Factura): string | null {
	for (const id of doc.snapshot.recipient.identifiers) {
		const digits = id.value.replace(/\s/g, "");
		if (/^(\d{9}|\d{10}|\d{13})$/.test(digits)) return digits;
	}
	return null;
}

/** The treatment of `doc` (see the header). */
function treatmentOf(doc: Factura, euVat: string | null): SalesDocument["treatment"] {
	const country = doc.snapshot.recipient.country;
	if (country === "BG") return "bg_vat_20";
	if (isEuCountry(country)) return euVat ? "eu_b2b_services_21_2" : "bg_vat_20";
	return "outside_eu_69_2";
}

/** One document as the package reads it; null when a non-EUR document has no EUR equivalent. */
function salesDocument(doc: Factura): SalesFileInput["documents"][number] | null {
	const s = doc.snapshot;
	const eur = s.eurEquivalent;
	if (s.currency !== "EUR" && !eur) return null;
	const country = s.recipient.country;
	const euVat = country !== "BG" ? vatNumberOf(doc, country) : null;
	return {
		kind: doc.kind === "credit_note" ? "credit_note" : "invoice",
		number: doc.number,
		issueDate: doc.issueDate,
		chargeableDate: doc.chargeableDate,
		recipient: {
			name: s.recipient.name,
			country,
			vatNumber: country === "BG" ? vatNumberOf(doc, "BG") : euVat,
			localId: country === "BG" ? localIdOf(doc) : null,
		},
		description: s.lines[0]?.description ?? "Услуга",
		treatment: treatmentOf(doc, euVat),
		currency: s.currency,
		amount: minorToDecimal(s.taxBaseMinor, s.currency),
		eurRate: s.currency === "EUR" ? null : (eur?.rate ?? null),
		netEur: minorToDecimal(s.currency === "EUR" ? s.taxBaseMinor : (eur?.taxBaseEurMinor ?? 0), "EUR"),
		vatEur: minorToDecimal(s.currency === "EUR" ? s.vatMinor : (eur?.vatEurMinor ?? 0), "EUR"),
		original: s.original,
	};
}

/** facturi-M.json for `month` from its documents, or every problem with them. */
export function salesFileFromFacturi(month: string, documents: readonly Factura[]): Parsed<SalesFile> {
	const problems: string[] = [];
	const rows: SalesFileInput["documents"] = [];
	for (const doc of [...documents].sort((a, b) => a.number.localeCompare(b.number))) {
		const row = salesDocument(doc);
		if (row) rows.push(row);
		else problems.push(`${doc.number}: in ${doc.snapshot.currency} with no EUR equivalent on the document`);
	}
	if (problems.length) return { ok: false, problems };
	return checkSalesFile({ version: 1, month, documents: rows });
}

/** facturi-M.json's bytes: pretty JSON, UTF-8, ending in a newline. */
export function salesFileJson(file: SalesFile): Uint8Array {
	return new TextEncoder().encode(`${JSON.stringify(file, null, 2)}\n`);
}
