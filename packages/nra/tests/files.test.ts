// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The NRA files of six months, checked as BYTES: a nil month, a reverse-charge-only month, the
// Paddle supply, a domestic 20 % sale, an EU B2B sale with VIES, and credit notes. Each file's text
// is a golden file (golden/<month>/<NAME>.txt, decoded from cp-1251, each CR LF shown as "␍" before
// the newline so the golden survives any checkout's line-ending setting). The rules a reader cannot
// see are checked on the bytes themselves: cp-1251, CR LF after every record and nothing else, the
// exact record widths of ППЗДДС Приложения № 12 and № 15, and each amount at its field's position.
//
// An intended change to a file: update the golden in the same PR and review its diff column by
// column against docs/legal/NRA_FILE_FORMATS.md.

import { describe, expect, it } from "vitest";
import { buildNraFiles, type NraFiles } from "../src/files";
import {
	DEKLAR_FIELDS,
	type FieldSpec,
	POKUPKI_FIELDS,
	PRODAGBI_FIELDS,
	recordWidth,
	VIES_TTR_FIELDS,
	VIES_VDR_FIELDS,
	VIES_VHR_FIELDS,
	VIES_VIR_FIELDS,
	VIES_VTR_FIELDS,
} from "../src/layout";
import { buildNraMonth } from "../src/month";
import { NraError } from "../src/record";
import {
	anthropicPurchase,
	awsPurchase,
	bgPurchase,
	domesticSale,
	euCreditNote,
	euSale,
	input,
	paddleSale,
	type PurchaseFixture,
	type SaleFixture,
	sales,
	stripeFee,
} from "./fixtures";

/** The files of a month. */
function files(docs: SaleFixture[], purchases: PurchaseFixture[] = []): NraFiles {
	const i = input(purchases);
	const r = buildNraMonth({ sales: sales(docs), input: i });
	if (!r.ok) throw new Error(r.problems.join("; "));
	return buildNraFiles(r.month, i.vies);
}

/** The file's records: split on CR LF; nothing may follow the last one. */
function records(bytes: Uint8Array): Uint8Array[] {
	const out: Uint8Array[] = [];
	let start = 0;
	for (let i = 0; i < bytes.length - 1; i++) {
		if (bytes[i] === 0x0d && bytes[i + 1] === 0x0a) {
			out.push(bytes.subarray(start, i));
			start = i + 2;
			i++;
		}
	}
	expect(start).toBe(bytes.length);
	return out;
}

/** The golden-file form of a file: cp-1251 decoded, CR LF shown as "␍\n". */
function golden(bytes: Uint8Array): string {
	return new TextDecoder("windows-1251").decode(bytes).replaceAll("\r\n", "␍\n");
}

/** Every record is printable cp-1251 (0x20-0xFF, no DEL) of exactly `width` bytes. */
function expectRecords(bytes: Uint8Array, width: number): Uint8Array[] {
	const rs = records(bytes);
	for (const r of rs) {
		expect(r.length).toBe(width);
		expect(r.every((b) => b >= 0x20 && b !== 0x7f)).toBe(true);
	}
	return rs;
}

/** The text of field `code` in a record of layout `fields`, trimmed. */
function field(record: Uint8Array, fields: readonly FieldSpec[], code: string): string {
	let at = 0;
	for (const f of fields) {
		if (f.code === code) return new TextDecoder("windows-1251").decode(record.subarray(at, at + f.width)).trim();
		at += f.width;
	}
	throw new Error(`no field ${code}`);
}

/** Checks each file's golden text and the byte rules. */
async function expectGoldens(name: string, nra: NraFiles): Promise<void> {
	expectRecords(nra.deklar, 590);
	expectRecords(nra.prodagbi, 424);
	expectRecords(nra.pokupki, 274);
	await expect(golden(nra.deklar)).toMatchFileSnapshot(`./golden/${name}/DEKLAR.txt`);
	await expect(golden(nra.prodagbi)).toMatchFileSnapshot(`./golden/${name}/PRODAGBI.txt`);
	await expect(golden(nra.pokupki)).toMatchFileSnapshot(`./golden/${name}/POKUPKI.txt`);
	if (nra.vies) await expect(golden(nra.vies)).toMatchFileSnapshot(`./golden/${name}/VIES.txt`);
}

describe("record widths (Appendix 12 and 15)", () => {
	it("sum to the widths the appendices' tables give", () => {
		expect(recordWidth(DEKLAR_FIELDS)).toBe(590);
		expect(recordWidth(PRODAGBI_FIELDS)).toBe(424);
		expect(recordWidth(POKUPKI_FIELDS)).toBe(274);
		expect(recordWidth(VIES_VHR_FIELDS)).toBe(15);
		expect(recordWidth(VIES_VDR_FIELDS)).toBe(373);
		expect(recordWidth(VIES_VTR_FIELDS)).toBe(368);
		expect(recordWidth(VIES_TTR_FIELDS)).toBe(27);
		expect(recordWidth(VIES_VIR_FIELDS)).toBe(66);
	});

	it("put the key cells at the positions NRA_FILE_FORMATS.md §4 prints", () => {
		const start = (fields: readonly FieldSpec[], code: string) => {
			let at = 1;
			for (const f of fields) {
				if (f.code === code) return at;
				at += f.width;
			}
			return -1;
		};
		expect([start(DEKLAR_FIELDS, "01-11"), start(DEKLAR_FIELDS, "01-17"), start(DEKLAR_FIELDS, "01-18"), start(DEKLAR_FIELDS, "01-31"), start(DEKLAR_FIELDS, "01-33"), start(DEKLAR_FIELDS, "01-40"), start(DEKLAR_FIELDS, "01-50")]).toEqual([182, 332, 347, 392, 467, 471, 486]);
		expect([start(PRODAGBI_FIELDS, "02-11"), start(PRODAGBI_FIELDS, "02-26"), start(PRODAGBI_FIELDS, "02-17"), start(PRODAGBI_FIELDS, "02-18")]).toEqual([198, 243, 363, 378]);
		expect([start(POKUPKI_FIELDS, "03-30"), start(POKUPKI_FIELDS, "03-31"), start(POKUPKI_FIELDS, "03-41")]).toEqual([168, 183, 198]);
	});
});

describe("a nil month", () => {
	it("is one DEKLAR record of zeros and two empty journals, no VIES", async () => {
		const nra = files([]);
		expect(nra.prodagbi.length).toBe(0);
		expect(nra.pokupki.length).toBe(0);
		expect(nra.vies).toBeNull();
		const [d] = expectRecords(nra.deklar, 590);
		if (!d) throw new Error("no record");
		for (const f of DEKLAR_FIELDS) if (f.format === "amount") expect(field(d, DEKLAR_FIELDS, f.code)).toBe("0.00");
		expect(field(d, DEKLAR_FIELDS, "01-33")).toBe("0.00");
		expect(field(d, DEKLAR_FIELDS, "00-05")).toBe("0");
		await expectGoldens("nil", nra);
	});
});

describe("a reverse-charge-only month", () => {
	it("nets to zero: 01-22 = 01-41 and 01-50 = 01-60 = 0", async () => {
		const nra = files([], [awsPurchase(), anthropicPurchase()]);
		const [d] = expectRecords(nra.deklar, 590);
		if (!d) throw new Error("no record");
		expect(["01-12", "01-22", "01-31", "01-41", "01-40", "01-50", "01-60"].map((c) => field(d, DEKLAR_FIELDS, c))).toEqual(["147.50", "29.50", "147.50", "29.50", "29.50", "0.00", "0.00"]);
		const sales = expectRecords(nra.prodagbi, 424);
		expect(sales.map((r) => [field(r, PRODAGBI_FIELDS, "02-04"), field(r, PRODAGBI_FIELDS, "02-10"), field(r, PRODAGBI_FIELDS, "02-26"), field(r, PRODAGBI_FIELDS, "02-22")])).toEqual([
			["09", "47.50", "47.50", "9.50"],
			["09", "100.00", "100.00", "20.00"],
		]);
		await expectGoldens("rc-only", nra);
	});
});

describe("the Paddle supply", () => {
	it("is 02-18 and 01-18, with 02-10 and 01-01 at 0.00", async () => {
		const nra = files([paddleSale()]);
		const [s] = expectRecords(nra.prodagbi, 424);
		const [d] = expectRecords(nra.deklar, 590);
		if (!s || !d) throw new Error("no record");
		expect([field(s, PRODAGBI_FIELDS, "02-07"), field(s, PRODAGBI_FIELDS, "02-18"), field(s, PRODAGBI_FIELDS, "02-10")]).toEqual(["999999999999999", "1234.56", "0.00"]);
		expect([field(d, DEKLAR_FIELDS, "01-18"), field(d, DEKLAR_FIELDS, "01-01"), field(d, DEKLAR_FIELDS, "01-50")]).toEqual(["1234.56", "0.00", "0.00"]);
		await expectGoldens("paddle", nra);
	});
});

describe("a domestic 20 % sale with a Bulgarian purchase", () => {
	it("pays 01-20 − 01-40", async () => {
		const nra = files([domesticSale()], [bgPurchase({ netEur: "10.00", amount: "10.00", vatEur: "2.00" })]);
		const [d] = expectRecords(nra.deklar, 590);
		if (!d) throw new Error("no record");
		expect(["01-11", "01-21", "01-20", "01-31", "01-41", "01-40", "01-50", "01-71"].map((c) => field(d, DEKLAR_FIELDS, c))).toEqual(["49.00", "9.80", "9.80", "10.00", "2.00", "2.00", "7.80", "7.80"]);
		await expectGoldens("domestic", nra);
	});
});

describe("an EU B2B sale", () => {
	it("is 02-17 with a VIES declaration of one line", async () => {
		const nra = files([euSale()], [stripeFee()]);
		expect(nra.vies).not.toBeNull();
		const v = records(nra.vies ?? new Uint8Array());
		expect(v.map((r) => r.length)).toEqual([15, 373, 368, 27, 66]);
		const vir = v[4];
		if (!vir) throw new Error("no VIR");
		expect([field(vir, VIES_VIR_FIELDS, "VIR.3"), field(vir, VIES_VIR_FIELDS, "VIR.6"), field(vir, VIES_VIR_FIELDS, "VIR.7")]).toEqual(["DE000000000", "114.00", ""]);
		expect(nra.pokupki.length).toBe(0); // the exempt Stripe fee is in neither journal
		await expectGoldens("eu-b2b", nra);
	});
});

describe("credit notes", () => {
	it("carry negative amounts, every value field of a record with the same sign or zero", async () => {
		const domesticCredit = domesticSale({ kind: "credit_note", number: "0000000105", issueDate: "2026-12-20", chargeableDate: "2026-12-20", amount: "-49.00", netEur: "-49.00", vatEur: "-9.80", original: { number: "0000000101", issueDate: "2026-12-03" } });
		const nra = files([euSale(), euCreditNote(), domesticCredit]);
		const rs = expectRecords(nra.prodagbi, 424);
		const credit = rs.filter((r) => field(r, PRODAGBI_FIELDS, "02-04") === "03");
		expect(credit.map((r) => [field(r, PRODAGBI_FIELDS, "02-17"), field(r, PRODAGBI_FIELDS, "02-11"), field(r, PRODAGBI_FIELDS, "02-21"), field(r, PRODAGBI_FIELDS, "02-10")])).toEqual([
			["-28.50", "0.00", "0.00", "0.00"],
			["0.00", "-49.00", "-9.80", "-49.00"],
		]);
		for (const r of rs) {
			const values = PRODAGBI_FIELDS.filter((f) => f.format === "amount").map((f) => Number(field(r, PRODAGBI_FIELDS, f.code)));
			expect(values.some((x) => x > 0) && values.some((x) => x < 0)).toBe(false);
		}
		const [d] = expectRecords(nra.deklar, 590);
		if (!d) throw new Error("no record");
		// A domestic credit note alone makes the month refundable: 01-20 = -9.80 → 01-60 = 9.80.
		expect(["01-17", "01-11", "01-20", "01-50", "01-60", "01-80"].map((c) => field(d, DEKLAR_FIELDS, c))).toEqual(["85.50", "-49.00", "-9.80", "0.00", "9.80", "9.80"]);
		await expectGoldens("credit-note", nra);
	});
});

describe("refusals at write time", () => {
	it("refuses a counterparty id longer than its field", () => {
		const i = input([awsPurchase({ supplier: { name: "Long", country: "LU", vatNumber: "LU00000000" } })]);
		const r = buildNraMonth({ sales: sales([]), input: i });
		if (!r.ok) throw new Error(r.problems.join("; "));
		const first = r.month.sales[0];
		if (!first) throw new Error("no line");
		first.counterpartyId = "LU0000000000000000";
		expect(() => buildNraFiles(r.month, i.vies)).toThrow(NraError);
	});

	it("transliterates and cuts free text, and says so", () => {
		const nra = files([euSale({ recipient: { name: "Müller Straße Großhandel GmbH & Co. KG — Niederlassung München Süd", country: "DE", vatNumber: "DE000000000", localId: null } })]);
		expect(nra.textNotes.some((n) => n.includes("02-08") && n.includes("Muller Strasse"))).toBe(true);
	});
});
