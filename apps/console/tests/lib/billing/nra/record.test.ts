// @vitest-environment node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #7457: the fixed-width writer and the cp-1251 encoder of the NRA files. Each rule of ППЗДДС
// Приложение № 12 it implements has a test here: widths are exact, text is left-aligned and numbers
// right-aligned with spaces, amounts carry "." and a minus and no leading zeros, dates are
// dd/mm/yyyy, and anything that does not fit is refused rather than cut. The encoder is checked
// byte for byte against the code page.

import { describe, expect, it } from "vitest";
import type { FieldSpec } from "@/lib/billing/nra/layout";
import {
	centsToDecimal,
	encodeCp1251,
	encodeRecords,
	fitText,
	isCp1251,
	NraError,
	renderRecord,
	toCp1251Text,
} from "@/lib/billing/nra/record";

/** A layout with one field of each format. */
const LAYOUT: FieldSpec[] = [
	{ code: "S", name: "text", width: 6, format: "symbolic", verified: true },
	{ code: "I", name: "count", width: 4, format: "integer", verified: true },
	{ code: "A", name: "amount", width: 10, format: "amount", verified: true },
	{ code: "C", name: "coefficient", width: 4, format: "coefficient", verified: true },
	{ code: "D", name: "date", width: 10, format: "date", verified: true },
	{ code: "P", name: "period", width: 6, format: "periodYm", verified: true },
	{ code: "Q", name: "period", width: 7, format: "periodMy", verified: true },
	{ code: "L", name: "literal", width: 3, format: "literal", literal: "VHR", verified: true },
];

/** Values for every field of LAYOUT, with `over` replacing some. */
function values(over: [string, string | number | null][] = []): Map<string, string | number | null> {
	return new Map<string, string | number | null>([
		["S", "Ab"],
		["I", 7],
		["A", -20000],
		["C", 0],
		["D", "2026-12-03"],
		["P", "2026-12"],
		["Q", "2026-12"],
		...over,
	]);
}

describe("encodeCp1251", () => {
	it("writes ASCII as itself and Cyrillic, №, the em dash and the euro sign at their cp-1251 bytes", () => {
		expect([...encodeCp1251("A1 .")]).toEqual([0x41, 0x31, 0x20, 0x2e]);
		expect([...encodeCp1251("АБВаяЁё")]).toEqual([0xc0, 0xc1, 0xc2, 0xe0, 0xff, 0xa8, 0xb8]);
		expect([...encodeCp1251("№—€")]).toEqual([0xb9, 0x97, 0x88]);
		expect([...encodeCp1251("\r\n")]).toEqual([0x0d, 0x0a]);
	});

	it("round-trips through the platform decoder", () => {
		const text = "Протокол № 0000000001 — Stripe, ДДС 20 %";
		expect(new TextDecoder("windows-1251").decode(encodeCp1251(text))).toBe(text);
	});

	it("refuses a character the code page lacks instead of writing '?'", () => {
		expect(() => encodeCp1251("Straße")).toThrow(NraError);
		expect(() => encodeCp1251("☃")).toThrow(/U\+2603/);
	});
});

describe("isCp1251 / toCp1251Text", () => {
	it("accepts printable cp-1251 and rejects control characters and missing letters", () => {
		expect(isCp1251("АЛЕТИЯ ЛАБС ЕДПК")).toBe(true);
		expect(isCp1251("tab\there")).toBe(false);
		expect(isCp1251("ü")).toBe(false);
	});

	it("drops a diacritic cp-1251 lacks and spells out ß, and says it changed the text", () => {
		expect(toCp1251Text("Müller  Straße\n5")).toEqual({ text: "Muller Strasse 5", changed: true });
		expect(toCp1251Text("Łódź ØRSTED")).toEqual({ text: "Lodz ORSTED", changed: true });
		expect(toCp1251Text("Иван")).toEqual({ text: "Иван", changed: false });
	});

	it("refuses a character with no cp-1251 form at all", () => {
		expect(() => toCp1251Text("日本")).toThrow(NraError);
	});
});

describe("centsToDecimal", () => {
	it("writes euro cents with a point and two places, a minus for negatives", () => {
		expect(centsToDecimal(0)).toBe("0.00");
		expect(centsToDecimal(5)).toBe("0.05");
		expect(centsToDecimal(12345)).toBe("123.45");
		expect(centsToDecimal(-20000)).toBe("-200.00");
	});

	it("refuses a fraction of a cent", () => {
		expect(() => centsToDecimal(1.5)).toThrow(NraError);
	});
});

describe("renderRecord", () => {
	it("writes each field at its width: text left, numbers right, spaces as padding", () => {
		const line = renderRecord(LAYOUT, values());
		expect(line).toBe(`Ab    ${"   7"}${"   -200.00"}0.0003/12/2026${"202612"}12/2026VHR`);
		expect(line.length).toBe(6 + 4 + 10 + 4 + 10 + 6 + 7 + 3);
	});

	it("writes an empty field as spaces", () => {
		const line = renderRecord(LAYOUT, values([["S", null], ["D", null], ["Q", ""]]));
		expect(line.slice(0, 6)).toBe("      ");
		expect(line.slice(24, 34)).toBe(" ".repeat(10));
		expect(line.slice(40, 47)).toBe(" ".repeat(7));
	});

	it("never pads an amount with zeros", () => {
		expect(renderRecord(LAYOUT, values([["A", 100]])).slice(10, 20)).toBe("      1.00");
	});

	it("refuses a value longer than its field", () => {
		expect(() => renderRecord(LAYOUT, values([["S", "Seven77"]]))).toThrow(/is 6 characters/);
		expect(() => renderRecord(LAYOUT, values([["A", 1_000_000_000]]))).toThrow(NraError);
	});

	it("refuses a missing, an unknown or a mistyped value", () => {
		const missing = values();
		missing.delete("I");
		expect(() => renderRecord(LAYOUT, missing)).toThrow(/I was not given/);
		expect(() => renderRecord(LAYOUT, values([["X", 1]]))).toThrow(/no field X/);
		expect(() => renderRecord(LAYOUT, values([["S", 5]]))).toThrow(/takes text/);
		expect(() => renderRecord(LAYOUT, values([["I", -1]]))).toThrow(/whole number/);
		expect(() => renderRecord(LAYOUT, values([["I", "7"]]))).toThrow(/whole number/);
		expect(() => renderRecord(LAYOUT, values([["A", "1.00"]]))).toThrow(/euro cents/);
		expect(() => renderRecord(LAYOUT, values([["C", 101]]))).toThrow(/hundredths/);
		expect(() => renderRecord(LAYOUT, values([["D", 3]]))).toThrow(/takes a date/);
		expect(() => renderRecord(LAYOUT, values([["P", 3]]))).toThrow(/takes a period/);
		expect(() => renderRecord(LAYOUT, values([["Q", 3]]))).toThrow(/takes a period/);
	});

	it("refuses a date or a period that is not real", () => {
		expect(() => renderRecord(LAYOUT, values([["D", "2026-02-30"]]))).toThrow(/not a date/);
		expect(() => renderRecord(LAYOUT, values([["P", "2026-13"]]))).toThrow(/not a period/);
	});

	it("refuses a symbolic value outside cp-1251", () => {
		expect(() => renderRecord(LAYOUT, values([["S", "ü"]]))).toThrow(/outside cp-1251/);
	});

	it("refuses the whole layout when any field is unverified, even an empty one", () => {
		const layout = [...LAYOUT, { code: "U", name: "unknown", width: 2, format: "symbolic" as const, verified: false }];
		expect(() => renderRecord(layout, values([["U", null]]))).toThrow(/unverified field\(s\) U/);
	});
});

describe("encodeRecords / fitText", () => {
	it("ends every record with CR LF, and writes no bytes for no records", () => {
		expect([...encodeRecords(["AB", "Я"])]).toEqual([0x41, 0x42, 0x0d, 0x0a, 0xdf, 0x0d, 0x0a]);
		expect(encodeRecords([]).length).toBe(0);
	});

	it("cuts free text to the width and says so", () => {
		expect(fitText("Google Workspace Business Starter", 30)).toEqual({ text: "Google Workspace Business Star", cut: true });
		expect(fitText("short", 30)).toEqual({ text: "short", cut: false });
		expect(fitText("ab cd", 3)).toEqual({ text: "ab", cut: true });
	});
});
