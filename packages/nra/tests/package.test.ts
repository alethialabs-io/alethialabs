// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The whole package of a full month (every kind of document at once): the file names, each protocol
// as text (golden) stating every point of чл. 117, ал. 2 and the credit right, SUMMARY.md (golden),
// the due date, the injected renderer, and that a refusal returns problems and no files.

import { describe, expect, it } from "vitest";
import { buildNraPackage } from "../src/package";
import { type ProtocolRenderer, protocolLayout, protocolText } from "../src/protocol";
import { ACCOUNTANT_QUESTIONS, dueDate } from "../src/summary";
import {
	anthropicPurchase,
	awsPurchase,
	bgPurchase,
	domesticSale,
	euCreditNote,
	euSale,
	FILER_VAT,
	input,
	paddleSale,
	sales,
	stripeFee,
} from "./fixtures";

/** A stand-in renderer: the protocol number as bytes. */
const stubRender: ProtocolRenderer = async (p) => new TextEncoder().encode(`%PDF-${p.number}`);

/** The full month: every treatment once. */
function fullMonth() {
	return {
		sales: sales([domesticSale(), euSale(), euCreditNote(), paddleSale()]),
		input: input([awsPurchase({ amount: "212.40", currency: "USD", eurRate: "0.95000000", netEur: "201.78" }), anthropicPurchase(), bgPurchase(), stripeFee()]),
	};
}

describe("dueDate", () => {
	it("is the 14th of the next month, across a year end", () => {
		expect(dueDate("2026-12")).toBe("2027-01-14");
		expect(dueDate("2027-01")).toBe("2027-02-14");
	});
});

describe("buildNraPackage", () => {
	it("writes the four files, a document and a .txt per protocol, and SUMMARY.md", async () => {
		const m = fullMonth();
		const pkg = await buildNraPackage(m.sales, m.input, stubRender, { demo: false });
		if (!pkg.ok) throw new Error(pkg.problems.join("; "));
		expect(pkg.files.map((f) => f.name)).toEqual([
			"DEKLAR.TXT",
			"PRODAGBI.TXT",
			"POKUPKI.TXT",
			"VIES.TXT",
			"protocols/0000000001.pdf",
			"protocols/0000000001.txt",
			"protocols/0000000002.pdf",
			"protocols/0000000002.txt",
			"SUMMARY.md",
		]);
		expect(new TextDecoder().decode(pkg.files[4]?.data)).toBe("%PDF-0000000001");
		// Worked by hand: output 9.80 + 9.50 + 40.36 = 59.66; credit 20.00 + 9.50 + 40.36 = 69.86.
		expect([pkg.cells.get("01-20"), pkg.cells.get("01-40"), pkg.cells.get("01-50"), pkg.cells.get("01-60"), pkg.cells.get("01-18"), pkg.cells.get("01-17")]).toEqual([5966, 6986, 0, 1020, 123456, 8550]);
		const summary = new TextDecoder().decode(pkg.files.at(-1)?.data);
		await expect(summary).toMatchFileSnapshot("./golden/full/SUMMARY.md");
		for (const q of ACCOUNTANT_QUESTIONS) expect(summary).toContain(q);
	});

	it("writes only the text copies without a renderer, and marks a demo", async () => {
		const m = fullMonth();
		const pkg = await buildNraPackage(m.sales, m.input, null, { demo: true });
		if (!pkg.ok) throw new Error(pkg.problems.join("; "));
		expect(pkg.files.some((f) => f.name.endsWith(".pdf"))).toBe(false);
		expect(new TextDecoder().decode(pkg.files.at(-1)?.data).startsWith("> **DEMO.")).toBe(true);
	});

	it("summarises a nil month: nothing payable, empty journals, no VIES", async () => {
		const pkg = await buildNraPackage(sales([]), input(), stubRender);
		if (!pkg.ok) throw new Error(pkg.problems.join("; "));
		const summary = new TextDecoder().decode(pkg.files.at(-1)?.data);
		expect(summary).not.toContain("DEMO");
		expect(summary).toContain("**Nil month.**");
		expect(summary).toContain("VAT payable (cell 50): EUR 0.00");
		expect(summary).toContain("not filed this month");
		expect(pkg.files.map((f) => f.name)).toEqual(["DEKLAR.TXT", "PRODAGBI.TXT", "POKUPKI.TXT", "SUMMARY.md"]);
	});

	it("returns a problem, not a file, when text cannot be written in cp-1251", async () => {
		const pkg = await buildNraPackage(sales([]), input([awsPurchase({ description: "☃ snow service" })]), stubRender);
		expect(pkg).toEqual({ ok: false, problems: [expect.stringContaining("cannot be written in cp-1251")] });
	});

	it("returns the problems and no files when the month is refused", async () => {
		const pkg = await buildNraPackage(sales([euSale()]), input([], { vies: undefined }), stubRender);
		expect(pkg.ok).toBe(false);
		expect("files" in pkg).toBe(false);
	});
});

describe("the protocols", () => {
	it("print every point of чл. 117, ал. 2 and the full credit right", async () => {
		const m = fullMonth();
		const pkg = await buildNraPackage(m.sales, m.input, null);
		if (!pkg.ok) throw new Error(pkg.problems.join("; "));
		const [anthropic, aws] = pkg.month.protocols;
		if (!anthropic || !aws) throw new Error("fixture");
		await expect(`${protocolText(protocolLayout(aws, FILER_VAT))}\n`).toMatchFileSnapshot("./golden/full/protocol-aws.txt");
		const text = protocolText(protocolLayout(anthropic, FILER_VAT));
		for (const part of ["№ 0000000001", "30.12.2026", "15.12.2026", `ДДС № / VAT No.: ${FILER_VAT}`, "Без ДДС номер в ЕС", "ANT-0042", "€47.50", "20 %", "€9.50", "USD 50.00", "чл. 82, ал. 2, т. 3 ЗДДС", "С право на пълен данъчен кредит (чл. 69, ал. 1, т. 2 ЗДДС)"]) {
			expect(text).toContain(part);
		}
		expect(text).not.toContain("Без право на данъчен кредит");
		expect(text).not.toContain("чл. 70, ал. 4");
	});
});
