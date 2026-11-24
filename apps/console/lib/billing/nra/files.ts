// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The four NRA files from one month (#7457): DEKLAR.TXT, PRODAGBI.TXT, POKUPKI.TXT (ППЗДДС
// Приложение № 12) and VIES.TXT (Приложение № 15), cp-1251, fixed width, CR LF. The layouts are in
// layout.ts, the writing rules in record.ts, and which document goes where in month.ts.
//
// THE TOTALS. DEKLAR's value cells are the sums of the journal columns Appendix 12 names for each
// (01-01 = Σ 02-10, 01-12 = Σ 02-12 + Σ 02-26, 01-30 = Σ 03-30 …), and the result cells follow its
// formulas: 01-40 = 01-41 + 01-42 × 01-33 + 01-43, 01-50 = 01-20 − 01-40 when ≥ 0, else 01-60.
// For a чл. 97а-only person there is no tax credit, so 01-40 is 0 and 01-50 is all the tax charged.
//
// A NIL MONTH. ЗДДС чл. 125, ал. 4 and ППЗДДС чл. 114, ал. 3: the return and the journals are filed
// even with nothing in them. DEKLAR is then one record of zeros; PRODAGBI and POKUPKI have no
// records at all ("няма да съдържат нито един запис", Appendix 12), i.e. zero bytes.

import { LEGAL_ENTITY } from "@repo/legal/entity";
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
import type { NraInput } from "./input";
import type { NraMonth } from "./month";
import { type FieldValue, encodeRecords, fitText, renderRecord, toCp1251Text } from "./record";

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

/** DEKLAR's value cells from the journals, with Appendix 12's formulas. */
export function deklarCells(month: NraMonth): DeklarCells {
	const s = month.sales;
	const c = new Map<string, number>();
	const reverseBase = sum(s, (e) => e.reverseChargeBase);
	const reverseVat = sum(s, (e) => e.reverseChargeVat);
	c.set("01-01", reverseBase); // Σ 02-10 = Σ (02-11 … 02-16, 02-26); here only 02-26 is used.
	c.set("01-20", reverseVat); // Σ 02-20 = Σ (02-21 … 02-24); here only 02-22.
	c.set("01-12", reverseBase); // Σ 02-12 + Σ 02-26.
	c.set("01-22", reverseVat);
	c.set("01-17", sum(s, (e) => e.euServiceBase));
	c.set("01-30", sum(month.purchases, (e) => e.noCreditBaseAndVat));
	const credit = 0; // 01-40 = 01-41 + 01-42 × 01-33 + 01-43: no credit under чл. 70, ал. 4.
	c.set("01-40", credit);
	const result = reverseVat - credit;
	c.set("01-50", result >= 0 ? result : 0);
	c.set("01-60", result < 0 ? -result : 0);
	c.set("01-71", result >= 0 ? result : 0); // Paid in full: nothing offset under чл. 92, ал. 1.
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
		const amounts = new Map<string, number>([
			["02-10", e.reverseChargeBase],
			["02-20", e.reverseChargeVat],
			["02-26", e.reverseChargeBase],
			["02-22", e.reverseChargeVat],
			["02-17", e.euServiceBase],
		]);
		const v = withAmounts(PRODAGBI_FIELDS, amounts);
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
		const v = withAmounts(POKUPKI_FIELDS, new Map([["03-30", e.noCreditBaseAndVat]]));
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
 * The four files of `month`. `vies` is the input file's VIES block; the caller has checked it is
 * present whenever the month has VIES lines (month.ts refuses otherwise).
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
