// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The four NRA files from one month: DEKLAR.TXT, PRODAGBI.TXT, POKUPKI.TXT (ППЗДДС Приложение
// № 12) and VIES.TXT (Приложение № 15), cp-1251, fixed width, CR LF. The layouts are in layout.ts,
// the writing rules in record.ts, and which document goes where in month.ts.
//
// THE TOTALS. Each journal record's 02-10 and 02-20 are Appendix 12's sums (02-10 = 02-11 + 02-12 +
// 02-13 + 02-14 + 02-15 + 02-16 + 02-26; 02-20 = 02-21 + 02-22 + 02-23 + 02-24). DEKLAR's value
// cells are the sums of the journal columns Appendix 12 names for each (01-01 = Σ 02-10, 01-12 =
// Σ 02-12 + Σ 02-26, 01-17 = Σ 02-17, 01-18 = Σ 02-18, 01-31 = Σ 03-31, 01-41 = Σ 03-41 …), and its
// result cells follow the printed formulas:
//   01-40 = 01-41 + 01-42 × 01-33 + 01-43   (01-42, 01-43 and the coefficient 01-33 are 0: the
//                                            company has no exempt supplies, so no partial credit)
//   01-50 = 01-20 − 01-40 when ≥ 0;  01-60 = its absolute value when < 0
//   01-70 = the earlier refundable VAT set off this period (input), at most 01-50; 01-71 = the rest
//   01-80 = 01-60 (refund by set-off over the next three periods, чл. 92, ал. 1); 01-81 = 01-82 = 0
//
// A NIL MONTH. ЗДДС чл. 125, ал. 4 and ППЗДДС чл. 114, ал. 3: the return and the journals are filed
// even with nothing in them. DEKLAR is then one record of zeros; PRODAGBI and POKUPKI have no
// records at all ("няма да съдържат нито един запис", Appendix 12), i.e. zero bytes.

import { LEGAL_ENTITY } from "@repo/legal/entity";
import type { NraInput } from "./input";
import {
	DEKLAR_FIELDS,
	type FieldSpec,
	POKUPKI_FIELDS,
	PRODAGBI_FIELDS,
	VIES_TTR_FIELDS,
	VIES_VDR_FIELDS,
	VIES_VHR_FIELDS,
	VIES_VIR_FIELDS,
	VIES_VTR_FIELDS,
} from "./layout";
import type { NraMonth, PurchaseEntry, SalesEntry } from "./month";
import { encodeRecords, type FieldValue, fitText, renderRecord, toCp1251Text } from "./record";

/** The company's name as the NRA register holds it. */
export const FILER_NAME = `${LEGAL_ENTITY.legalNameBulgarian} ЕДПК`;

/** The value cells of DEKLAR, euro cents, keyed by cell code. */
export type DeklarCells = ReadonlyMap<string, number>;

/** The NRA files and what writing them had to change. */
export interface NraFiles {
	deklar: Uint8Array;
	prodagbi: Uint8Array;
	pokupki: Uint8Array;
	/** Null in a month with no EU B2B service sales: no VIES declaration is filed (чл. 125, ал. 2). */
	vies: Uint8Array | null;
	cells: DeklarCells;
	/** Free text that was transliterated or cut to fit its field. */
	textNotes: string[];
}

/** Collects the notes of free text fitted into fields. */
class TextFitter {
	readonly notes: string[] = [];

	/** `text` made cp-1251 and cut to `field`'s width, noting any change. */
	fit(text: string, fields: readonly FieldSpec[], code: string, where: string): string {
		const width = fields.find((field) => field.code === code)?.width ?? 0;
		const encoded = toCp1251Text(text);
		const cut = fitText(encoded.text, width);
		if (encoded.changed || cut.cut) this.notes.push(`${where}, ${code}: "${text}" written as "${cut.text}"`);
		return cut.text;
	}
}

/** Every amount cell of `fields` set to 0, plus `set`. */
function withAmounts(fields: readonly FieldSpec[], set: ReadonlyMap<string, number>): Map<string, FieldValue> {
	const m = new Map<string, FieldValue>();
	for (const field of fields) if (field.format === "amount") m.set(field.code, set.get(field.code) ?? 0);
	return m;
}

/** The sum of `pick` over `rows`. */
function sum<T>(rows: readonly T[], pick: (r: T) => number): number {
	return rows.reduce((n, r) => n + pick(r), 0);
}

/** The cells of Appendix 12's 02-10 sum. */
const SALES_BASE_CELLS = ["02-11", "02-12", "02-13", "02-14", "02-15", "02-16", "02-26"] as const;
/** The cells of Appendix 12's 02-20 sum. */
const SALES_VAT_CELLS = ["02-21", "02-22", "02-23", "02-24"] as const;

/** Every amount of a sales-journal record, with 02-10 and 02-20 computed. */
export function salesAmounts(e: SalesEntry): Map<string, number> {
	const m = new Map<string, number>(Object.entries(e.cells));
	m.set("02-10", sum(SALES_BASE_CELLS, (c) => m.get(c) ?? 0));
	m.set("02-20", sum(SALES_VAT_CELLS, (c) => m.get(c) ?? 0));
	return m;
}

/** Every amount of a purchase-journal record. */
function purchaseAmounts(e: PurchaseEntry): Map<string, number> {
	return new Map<string, number>(Object.entries(e.cells));
}

/** DEKLAR's value cells from the journals, with Appendix 12's formulas. */
export function deklarCells(month: NraMonth): DeklarCells {
	const s = month.sales.map(salesAmounts);
	const p = month.purchases.map(purchaseAmounts);
	const S = (code: string) => sum(s, (m) => m.get(code) ?? 0);
	const P = (code: string) => sum(p, (m) => m.get(code) ?? 0);
	const c = new Map<string, number>();
	c.set("01-01", S("02-10"));
	c.set("01-20", S("02-20"));
	c.set("01-11", S("02-11"));
	c.set("01-21", S("02-21"));
	c.set("01-12", S("02-12") + S("02-26"));
	c.set("01-22", S("02-22"));
	c.set("01-23", S("02-23"));
	c.set("01-13", S("02-13"));
	c.set("01-24", S("02-24"));
	c.set("01-14", S("02-14"));
	c.set("01-15", S("02-15"));
	c.set("01-16", S("02-16"));
	c.set("01-17", S("02-17"));
	c.set("01-18", S("02-18"));
	c.set("01-19", S("02-19"));
	c.set("01-30", P("03-30"));
	c.set("01-31", P("03-31"));
	c.set("01-41", P("03-41"));
	c.set("01-32", P("03-32"));
	c.set("01-42", P("03-42"));
	c.set("01-43", P("03-43"));
	// 01-33 is 0.00, so 01-42 × 01-33 is 0: 01-40 = 01-41 + 01-43.
	const credit = (c.get("01-41") ?? 0) + (c.get("01-43") ?? 0);
	c.set("01-40", credit);
	const result = (c.get("01-20") ?? 0) - credit;
	const payable = result >= 0 ? result : 0;
	const refundable = result < 0 ? -result : 0;
	c.set("01-50", payable);
	c.set("01-60", refundable);
	const offset = Math.min(month.refundOffset, payable);
	c.set("01-70", offset);
	c.set("01-71", payable - offset);
	c.set("01-80", refundable);
	c.set("01-81", 0);
	c.set("01-82", 0);
	return c;
}

/** DEKLAR.TXT: the one record. */
function deklar(month: NraMonth, cells: DeklarCells, fit: TextFitter): string {
	const v = withAmounts(DEKLAR_FIELDS, cells);
	v.set("00-01", month.filer.vatNumber);
	v.set("00-02", fit.fit(FILER_NAME, DEKLAR_FIELDS, "00-02", "DEKLAR"));
	v.set("00-03", month.window.month);
	v.set("00-04", fit.fit(month.filer.submitter, DEKLAR_FIELDS, "00-04", "DEKLAR"));
	v.set("00-05", month.sales.length);
	v.set("00-06", month.purchases.length);
	v.set("01-33", 0);
	return renderRecord(DEKLAR_FIELDS, v);
}

/** PRODAGBI.TXT: one record per sales-journal line, numbered from 1. */
function prodagbi(month: NraMonth, fit: TextFitter): string[] {
	return month.sales.map((e, i) => {
		const where = `PRODAGBI line ${i + 1} (${e.number})`;
		const v = withAmounts(PRODAGBI_FIELDS, salesAmounts(e));
		v.set("02-00", month.filer.vatNumber);
		v.set("02-01", month.window.month);
		v.set("02-02", 0);
		v.set("02-03", i + 1);
		v.set("02-04", e.docType);
		v.set("02-05", e.number);
		v.set("02-06", e.date);
		v.set("02-07", e.counterpartyId);
		v.set("02-08", fit.fit(e.counterpartyName, PRODAGBI_FIELDS, "02-08", where));
		v.set("02-09", fit.fit(e.description, PRODAGBI_FIELDS, "02-09", where));
		v.set("02-27", null);
		return renderRecord(PRODAGBI_FIELDS, v);
	});
}

/** POKUPKI.TXT: one record per purchase-journal line, numbered from 1. */
function pokupki(month: NraMonth, fit: TextFitter): string[] {
	return month.purchases.map((e, i) => {
		const where = `POKUPKI line ${i + 1} (${e.number})`;
		const v = withAmounts(POKUPKI_FIELDS, purchaseAmounts(e));
		v.set("03-02", month.filer.vatNumber);
		v.set("03-01", month.window.month);
		v.set("03-03", 0);
		v.set("03-04", i + 1);
		v.set("03-05", e.docType);
		v.set("03-06", e.number);
		v.set("03-07", e.date);
		v.set("03-08", e.counterpartyId);
		v.set("03-09", fit.fit(e.counterpartyName, POKUPKI_FIELDS, "03-09", where));
		v.set("03-10", fit.fit(e.description, POKUPKI_FIELDS, "03-10", where));
		v.set("03-45", null);
		return renderRecord(POKUPKI_FIELDS, v);
	});
}

/** VIES.TXT: the sections of variant 1 of Appendix 15 (VHR, VDR, VTR, TTR, VIR…). */
function viesLines(month: NraMonth, vies: NonNullable<NraInput["vies"]>, fit: TextFitter): string[] {
	const d = vies.declarant;
	const services = sum(month.vies, (l) => l.servicesBase);
	return [
		renderRecord(VIES_VHR_FIELDS, new Map<string, FieldValue>([["VHR.2", month.window.month], ["VHR.3", month.vies.length]])),
		renderRecord(
			VIES_VDR_FIELDS,
			new Map<string, FieldValue>([
				["VDR.2", d.personalId],
				["VDR.3", fit.fit(d.name, VIES_VDR_FIELDS, "VDR.3", "VIES declarant")],
				["VDR.4", fit.fit(d.city, VIES_VDR_FIELDS, "VDR.4", "VIES declarant")],
				["VDR.5", Number(d.postcode)],
				["VDR.6", fit.fit(d.address, VIES_VDR_FIELDS, "VDR.6", "VIES declarant")],
				["VDR.7", d.capacity],
			]),
		),
		renderRecord(
			VIES_VTR_FIELDS,
			new Map<string, FieldValue>([
				["VTR.2", month.filer.vatNumber],
				["VTR.3", fit.fit(FILER_NAME, VIES_VTR_FIELDS, "VTR.3", "VIES registered person")],
				["VTR.4", fit.fit(vies.correspondenceAddress, VIES_VTR_FIELDS, "VTR.4", "VIES registered person")],
			]),
		),
		renderRecord(VIES_TTR_FIELDS, new Map<string, FieldValue>([["TTR.2", services], ["TTR.3", 0]])),
		...month.vies.map((l, i) =>
			renderRecord(
				VIES_VIR_FIELDS,
				new Map<string, FieldValue>([
					["VIR.2", i + 1],
					["VIR.3", l.vatNumber],
					["VIR.4", 0],
					["VIR.5", 0],
					["VIR.6", l.servicesBase],
					// Left empty when the tax became chargeable in the declaration's own period (Appendix 15).
					["VIR.7", l.period === month.window.month ? null : l.period],
				]),
			),
		),
	];
}

/**
 * The four files of `month`. `vies` is the input file's VIES block; month.ts has refused a month
 * with VIES lines and no block. Throws NraError when a value does not fit its field.
 */
export function buildNraFiles(month: NraMonth, vies: NraInput["vies"]): NraFiles {
	const fit = new TextFitter();
	const cells = deklarCells(month);
	const deklarRecord = deklar(month, cells, fit);
	const sales = prodagbi(month, fit);
	const purchases = pokupki(month, fit);
	const viesFile = month.vies.length && vies ? encodeRecords(viesLines(month, vies, fit)) : null;
	return {
		deklar: encodeRecords([deklarRecord]),
		prodagbi: encodeRecords(sales),
		pokupki: encodeRecords(purchases),
		vies: viesFile,
		cells,
		textNotes: fit.notes,
	};
}
