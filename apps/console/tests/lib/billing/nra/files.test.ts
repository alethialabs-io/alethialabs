// @vitest-environment node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #7457: the four NRA files of the demo month, checked as BYTES. Each file's text is a golden file
// (golden/<NAME>.txt, decoded from cp-1251, each CR LF shown as "␍" before the newline so the
// golden file survives any checkout's line-ending setting); the bytes themselves are pinned by
// SHA-256 and checked for the rules a reader cannot see: cp-1251, CR LF after every record, the
// exact record widths of ППЗДДС Приложения № 12 and № 15. A nil month and the layout widths are
// checked too.
//
// An intended change to a file: update the golden file and the SHA-256 in the same PR, and review
// the diff column by column against docs/legal/NRA_FILE_FORMATS.md.

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { demoMonth } from "@/lib/billing/nra/demo";
import { buildNraFiles, deklarCells } from "@/lib/billing/nra/files";
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
} from "@/lib/billing/nra/layout";
import { buildNraMonth, type NraMonth } from "@/lib/billing/nra/month";
import { NraError } from "@/lib/billing/nra/record";

/** The demo month, built. */
function demo(over: (m: ReturnType<typeof demoMonth>) => ReturnType<typeof demoMonth> = (m) => m): NraMonth {
	const r = buildNraMonth(over(demoMonth()));
	if (!r.ok) throw new Error(r.problems.join("; "));
	return r.month;
}

/** The file's records: split on CR LF, the trailing empty piece dropped. */
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
	expect(start).toBe(bytes.length); // nothing after the last CR LF
	return out;
}

/** The golden-file form of a file: cp-1251 decoded, CR LF shown as "␍\n". */
function golden(bytes: Uint8Array): string {
	return new TextDecoder("windows-1251").decode(bytes).replaceAll("\r\n", "␍\n");
}

/** Lower-case hex SHA-256. */
function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/** True when no byte is a lone CR or LF, a tab, or another control character. */
function onlyPrintableAndCrLf(bytes: Uint8Array): boolean {
	return records(bytes).every((r) => r.every((b) => b >= 0x20 && b !== 0x7f));
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

	it("name each field once, and every field is verified", () => {
		const all: FieldSpec[][] = [[...DEKLAR_FIELDS], [...PRODAGBI_FIELDS], [...POKUPKI_FIELDS], [...VIES_VHR_FIELDS, ...VIES_VDR_FIELDS, ...VIES_VTR_FIELDS, ...VIES_TTR_FIELDS, ...VIES_VIR_FIELDS]];
		for (const fields of all) {
			expect(new Set(fields.map((f) => f.code)).size).toBe(fields.length);
			expect(fields.filter((f) => !f.verified)).toEqual([]);
		}
	});

	it("keep the appendix's row order where it is not code order", () => {
		expect(DEKLAR_FIELDS.slice(6, 9).map((f) => f.code)).toEqual(["01-01", "01-20", "01-11"]);
		expect(POKUPKI_FIELDS.slice(0, 2).map((f) => f.code)).toEqual(["03-02", "03-01"]);
		expect(PRODAGBI_FIELDS.slice(14, 17).map((f) => f.code)).toEqual(["02-12", "02-26", "02-22"]);
	});
});

describe("the demo month's files", () => {
	const month = demo();
	const files = buildNraFiles(month, demoMonth().operator.vies);

	it("DEKLAR.TXT is one 590-character record, as golden/DEKLAR.txt", async () => {
		const recs = records(files.deklar);
		expect(recs.map((r) => r.length)).toEqual([590]);
		expect(onlyPrintableAndCrLf(files.deklar)).toBe(true);
		await expect(golden(files.deklar)).toMatchFileSnapshot("./golden/DEKLAR.txt");
	});

	it("PRODAGBI.TXT has one 424-character record per sales-journal line, numbered 1…n", async () => {
		const recs = records(files.prodagbi);
		expect(recs.map((r) => r.length)).toEqual([424, 424, 424, 424, 424]);
		const seq = recs.map((r) => new TextDecoder("windows-1251").decode(r.subarray(25, 40)).trim());
		expect(seq).toEqual(["1", "2", "3", "4", "5"]);
		await expect(golden(files.prodagbi)).toMatchFileSnapshot("./golden/PRODAGBI.txt");
	});

	it("POKUPKI.TXT has one 274-character record per protocol", async () => {
		expect(records(files.pokupki).map((r) => r.length)).toEqual([274, 274, 274]);
		await expect(golden(files.pokupki)).toMatchFileSnapshot("./golden/POKUPKI.txt");
	});

	it("VIES.TXT has the sections of variant 1 in order, each at its width", async () => {
		const recs = records(files.vies ?? new Uint8Array());
		expect(recs.map((r) => [new TextDecoder().decode(r.subarray(0, 3)), r.length])).toEqual([
			["VHR", 15],
			["VDR", 373],
			["VTR", 368],
			["TTR", 27],
			["VIR", 66],
		]);
		await expect(golden(files.vies ?? new Uint8Array())).toMatchFileSnapshot("./golden/VIES.txt");
	});

	it("writes Cyrillic as cp-1251 bytes, not UTF-8", () => {
		// "АЛЕТИЯ" in cp-1251 at DEKLAR 00-02 (position 16).
		expect([...files.deklar.subarray(15, 21)]).toEqual([0xc0, 0xcb, 0xc5, 0xd2, 0xc8, 0xdf]);
		// "Пр" of the submitter at 00-04 (position 82, after the 10-digit ЕГН and a space).
		expect([...files.deklar.subarray(82, 84)]).toEqual([0xcf, 0xf0]);
		// The bytes are not UTF-8: a UTF-8 decoder meets invalid sequences.
		expect(new TextDecoder("utf-8").decode(files.deklar)).toContain("\uFFFD");
	});

	it("pins every file's bytes", () => {
		expect({
			deklar: sha256(files.deklar),
			prodagbi: sha256(files.prodagbi),
			pokupki: sha256(files.pokupki),
			vies: sha256(files.vies ?? new Uint8Array()),
		}).toMatchInlineSnapshot(`
			{
			  "deklar": "26c49aa6d97f1f8aacb67e01de67da2989597487e5156061fc4748b6f4aba5b4",
			  "pokupki": "24da84c01498fc61c986c4df37acf02f86a540f5f208b7d20f6a46319d0112ec",
			  "prodagbi": "74a6cab01196cecc708ed2aa4ff2cb57bb5279b15d998ca7aa9d6c1a53824ea4",
			  "vies": "ddccaaba6fc65b5ca83dd6780c864c4dfc9ef354fe5a6cb3c863743bcde77619",
			}
		`);
	});

	it("puts 02-17 outside 02-10 and the protocols' 02-26 inside it (Appendix 12's 02-10 formula)", () => {
		const text = new TextDecoder("windows-1251").decode(files.prodagbi).split("\r\n");
		// 02-10 is at 167..182 (after the ten fixed fields), 02-17 at 167 + 13 × 15.
		const at = (line: string, i: number) => line.slice(167 + i * 15, 182 + i * 15).trim();
		const invoice = text[0] ?? "";
		expect([at(invoice, 0), at(invoice, 13)]).toEqual(["0.00", "114.00"]);
		const protocol = text[1] ?? "";
		expect([at(protocol, 0), at(protocol, 1), at(protocol, 5), at(protocol, 6)]).toEqual(["6.80", "1.36", "6.80", "1.36"]);
	});

	it("sums the cells from the journals, with no tax credit", () => {
		expect(Object.fromEntries(files.cells)).toEqual({
			"01-01": 5316,
			"01-20": 1063,
			"01-12": 5316,
			"01-22": 1063,
			"01-17": 8550,
			"01-30": 6379,
			"01-40": 0,
			"01-50": 1063,
			"01-60": 0,
			"01-71": 1063,
		});
	});

	it("writes no VIES.TXT in a month without EU B2B sales", () => {
		const noEu = demo((m) => ({ ...m, documents: m.documents.slice(0, 1) }));
		expect(buildNraFiles(noEu, undefined).vies).toBeNull();
	});
});

describe("a nil month", () => {
	const month = demo((m) => ({ ...m, documents: [], balance: [], operator: { ...m.operator, purchases: [], stripe: undefined, vies: undefined } }));
	const files = buildNraFiles(month, undefined);

	it("files a DEKLAR record of zeros and empty journals", async () => {
		expect(records(files.deklar).map((r) => r.length)).toEqual([590]);
		expect(files.prodagbi.length).toBe(0);
		expect(files.pokupki.length).toBe(0);
		expect(files.vies).toBeNull();
		await expect(golden(files.deklar)).toMatchFileSnapshot("./golden/DEKLAR-nil.txt");
	});

	it("has every cell at zero", () => {
		expect([...deklarCells(month).values()].every((v) => v === 0)).toBe(true);
	});
});

describe("a refund larger than the tax", () => {
	it("moves the result to 01-60 (ДДС за възстановяване)", () => {
		const month = demo();
		const negative: NraMonth = { ...month, sales: month.sales.map((s) => ({ ...s, reverseChargeVat: -Math.abs(s.reverseChargeVat) })) };
		const cells = deklarCells(negative);
		expect([cells.get("01-50"), cells.get("01-60"), cells.get("01-71")]).toEqual([0, 1063, 0]);
	});
});

describe("text that cannot be written", () => {
	it("refuses a name with no cp-1251 form, and notes one it had to change or cut", () => {
		const month = demo();
		const bad: NraMonth = { ...month, sales: month.sales.map((s, i) => (i === 0 ? { ...s, counterpartyName: "株式会社" } : s)) };
		expect(() => buildNraFiles(bad, demoMonth().operator.vies)).toThrow(NraError);
		const changed: NraMonth = { ...month, sales: month.sales.map((s, i) => (i === 0 ? { ...s, counterpartyName: "Müller Straße GmbH" } : s)) };
		const files = buildNraFiles(changed, demoMonth().operator.vies);
		expect(files.textNotes).toEqual(
			expect.arrayContaining([
				'PRODAGBI line 1 (0000000102), 02-08: "Müller Straße GmbH" written as "Muller Strasse GmbH"',
				expect.stringContaining('02-09: "Google Workspace Business Starter" written as "Google Workspace Business Star"'),
			]),
		);
	});
});
