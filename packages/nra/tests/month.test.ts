// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Which document goes in which journal and cell for a чл. 100 company, and the DEKLAR result cells
// computed from them, with every expected figure worked out by hand in the test (not read back from
// the generator). Also each refusal: the generator stops rather than guess.

import { describe, expect, it } from "vitest";
import { deklarCells } from "../src/files";
import { parseNraInput } from "../src/input";
import { buildNraMonth, buildSingleProtocol, convertToEurCents, type NraMonth, vatOf } from "../src/month";
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
	type PurchaseFixture,
	type SaleFixture,
	sales,
	stripeFee,
} from "./fixtures";

/** The built month, or a thrown list of problems. */
function month(docs: SaleFixture[], purchases: PurchaseFixture[] = [], over: Parameters<typeof input>[1] = {}): NraMonth {
	const r = buildNraMonth({ sales: sales(docs), input: input(purchases, over) });
	if (!r.ok) throw new Error(r.problems.join("; "));
	return r.month;
}

/** The problems of a month that must be refused. */
function problems(docs: SaleFixture[], purchases: PurchaseFixture[] = [], over: Parameters<typeof input>[1] = {}): string[] {
	const r = buildNraMonth({ sales: sales(docs), input: input(purchases, over) });
	if (r.ok) throw new Error("expected a refusal");
	return r.problems;
}

/** DEKLAR's cells in euro decimals, only the non-zero ones. */
function nonZero(m: NraMonth): Record<string, number> {
	const out: Record<string, number> = {};
	for (const [k, v] of deklarCells(m)) if (v !== 0) out[k] = v;
	return out;
}

describe("vatOf and convertToEurCents", () => {
	it("round half away from zero to the cent", () => {
		expect(vatOf(20178)).toBe(4036); // 40.356
		expect(vatOf(-2850)).toBe(-570);
		expect(vatOf(1)).toBe(0); // 0.2 cent
		expect(vatOf(3)).toBe(1); // 0.6 cent
		expect(convertToEurCents("212.40", "0.95000000")).toBe(20178);
		expect(convertToEurCents("-30.00", "0.95")).toBe(-2850);
		expect(convertToEurCents("0.01", "0.5")).toBe(1); // 0.5 cent rounds up
		expect(convertToEurCents("1000", "1.17123456")).toBe(117123);
	});
});

describe("a nil month", () => {
	it("has empty journals and every DEKLAR cell zero", () => {
		const m = month([]);
		expect(m.sales).toEqual([]);
		expect(m.purchases).toEqual([]);
		expect(m.vies).toEqual([]);
		expect(nonZero(m)).toEqual({});
	});
});

describe("a reverse-charge-only month", () => {
	it("self-assesses 20 % in the sales journal and takes the same amount back as credit: net 0", () => {
		const m = month([], [awsPurchase()]);
		expect(m.protocols).toHaveLength(1);
		expect(m.protocols[0]).toMatchObject({ number: "0000000001", issueDate: "2026-12-31", taxEventDate: "2026-12-31", base: 10000, vat: 2000 });
		expect(m.sales).toEqual([
			expect.objectContaining({ docType: "09", number: "0000000001", counterpartyId: "LU00000000", cells: { "02-26": 10000, "02-22": 2000 } }),
		]);
		expect(m.purchases).toEqual([expect.objectContaining({ docType: "09", number: "0000000001", cells: { "03-31": 10000, "03-41": 2000 } })]);
		expect(nonZero(m)).toEqual({ "01-01": 10000, "01-20": 2000, "01-12": 10000, "01-22": 2000, "01-31": 10000, "01-41": 2000, "01-40": 2000 });
	});

	it("dates each protocol the earlier of the tax event + 15 days and the month's last day, numbered in date order", () => {
		const m = month([], [awsPurchase(), anthropicPurchase(), anthropicPurchase({ documentNumber: "ANT-0050", documentDate: "2026-12-20", taxEventDate: "2026-12-20" })]);
		expect(m.protocols.map((p) => [p.number, p.issueDate, p.supplier.name])).toEqual([
			["0000000001", "2026-12-30", "Anthropic, PBC"],
			["0000000002", "2026-12-31", "Anthropic, PBC"],
			["0000000003", "2026-12-31", "Amazon Web Services EMEA SARL"],
		]);
		expect(m.protocols[0]?.conversion).toEqual({ currency: "USD", amount: "50.00", eurRate: "0.95000000" });
		expect(m.sales[0]?.counterpartyId).toBe("999999999999999"); // no EU VAT number
	});

	it("keeps a protocol already issued (number and date given) and numbers the rest around it", () => {
		const m = month([], [anthropicPurchase({ protocolNumber: "1", protocolDate: "2026-12-16" }), awsPurchase()]);
		expect(m.protocols.map((p) => [p.number, p.issueDate])).toEqual([
			["0000000001", "2026-12-16"],
			["0000000002", "2026-12-31"],
		]);
	});
});

describe("the Paddle supply (чл. 69, ал. 2)", () => {
	it("is 02-18 / 01-18 with the foreign-person code, outside 01-01 and with no VAT", () => {
		const m = month([paddleSale()]);
		expect(m.sales).toEqual([expect.objectContaining({ docType: "01", counterpartyId: "999999999999999", cells: { "02-18": 123456 } })]);
		expect(nonZero(m)).toEqual({ "01-18": 123456 });
		expect(m.vies).toEqual([]);
	});

	it("is refused for a recipient inside the EU", () => {
		expect(problems([paddleSale({ recipient: { name: "X", country: "IE", vatNumber: "IE0000000XX", localId: null } })])[0]).toMatch(/outside the EU/);
	});
});

describe("a domestic 20 % sale", () => {
	it("is 02-11 / 02-21 and makes VAT payable", () => {
		const m = month([domesticSale()]);
		expect(m.sales[0]).toMatchObject({ counterpartyId: "BG000000000", cells: { "02-11": 4900, "02-21": 980 } });
		expect(nonZero(m)).toEqual({ "01-01": 4900, "01-20": 980, "01-11": 4900, "01-21": 980, "01-50": 980, "01-71": 980 });
	});

	it("uses the ЕИК, then the foreign-person code, when the customer has no VAT number", () => {
		expect(month([domesticSale({ recipient: { name: "Фирма", country: "BG", vatNumber: null, localId: "000000000" } })]).sales[0]?.counterpartyId).toBe("000000000");
		expect(month([domesticSale({ recipient: { name: "Иван", country: "BG", vatNumber: null, localId: null } })]).sales[0]?.counterpartyId).toBe("999999999999999");
	});

	it("is refused when the VAT is not 20 % (one cent of rounding is a note)", () => {
		expect(problems([domesticSale({ vatEur: "9.00" })])[0]).toMatch(/not 20 %/);
		expect(month([domesticSale({ vatEur: "9.81" })]).notes[0]).toMatch(/one cent/);
	});

	it("sets off earlier refundable VAT in 01-70 and leaves the rest in 01-71", () => {
		const m = month([domesticSale()], [], { deklar: { refundOffsetEur: "5.00" } });
		expect(nonZero(m)).toMatchObject({ "01-50": 980, "01-70": 500, "01-71": 480 });
		const capped = month([domesticSale()], [], { deklar: { refundOffsetEur: "50.00" } });
		expect(nonZero(capped)).toMatchObject({ "01-50": 980, "01-70": 980 });
		expect(nonZero(capped)["01-71"]).toBeUndefined();
	});
});

describe("an EU B2B sale", () => {
	it("is 02-17 at the EUR equivalent, outside 01-01, with one VIES line", () => {
		const m = month([euSale()]);
		expect(m.sales[0]).toMatchObject({ counterpartyId: "DE000000000", cells: { "02-17": 11400 } });
		expect(m.vies).toEqual([{ vatNumber: "DE000000000", servicesBase: 11400, period: "2026-12" }]);
		expect(nonZero(m)).toEqual({ "01-17": 11400 });
	});

	it("is refused without a VAT number of the customer's own member state, or with VAT", () => {
		expect(problems([euSale({ recipient: { name: "X", country: "DE", vatNumber: "FR00000000000", localId: null } })])[0]).toMatch(/VAT number of that state/);
		expect(problems([euSale({ vatEur: "22.80" })])[0]).toMatch(/no Bulgarian VAT/);
	});

	it("writes a Greek customer's number with EL", () => {
		const m = month([euSale({ recipient: { name: "Ελλάς", country: "GR", vatNumber: "GR000000000", localId: null } })]);
		expect(m.vies[0]?.vatNumber).toBe("EL000000000");
	});

	it("needs the VIES block", () => {
		expect(problems([euSale()], [], { vies: undefined })).toContain("the month has EU B2B sales: add the vies block (declarant and correspondence address)");
	});

	it("is refused when the EUR amount does not follow from the rate", () => {
		expect(problems([euSale({ netEur: "115.00" })])[0]).toMatch(/× 0.95000000 is EUR 114.00/);
	});
});

describe("a credit note", () => {
	it("is type 03 with negative amounts in its фактура's cells, and nets the VIES line", () => {
		const m = month([euSale(), euCreditNote(), domesticSale(), domesticSale({ kind: "credit_note", number: "0000000105", issueDate: "2026-12-20", chargeableDate: "2026-12-20", amount: "-49.00", netEur: "-49.00", vatEur: "-9.80", original: { number: "0000000101", issueDate: "2026-12-03" } })]);
		expect(m.sales.map((e) => [e.docType, e.number, e.cells])).toEqual([
			["01", "0000000101", { "02-11": 4900, "02-21": 980 }],
			["01", "0000000102", { "02-17": 11400 }],
			["03", "0000000103", { "02-17": -2850 }],
			["03", "0000000105", { "02-11": -4900, "02-21": -980 }],
		]);
		expect(m.vies).toEqual([{ vatNumber: "DE000000000", servicesBase: 8550, period: "2026-12" }]);
		expect(nonZero(m)).toEqual({ "01-17": 8550 });
	});

	it("is refused with a positive amount", () => {
		expect(problems([euCreditNote({ amount: "30.00", netEur: "28.50" })])[0]).toMatch(/credit note has positive/);
	});
});

describe("purchases", () => {
	it("a Bulgarian фактура with full credit is 03-31 / 03-41; with no credit, base plus tax in 03-30", () => {
		const m = month([], [bgPurchase(), bgPurchase({ documentNumber: "0000004712", treatment: "bg_vat_no_credit", description: "Представителни" })]);
		expect(m.purchases.map((e) => [e.docType, e.number, e.counterpartyId, e.cells])).toEqual([
			["01", "0000004711", "BG000000001", { "03-31": 10000, "03-41": 2000 }],
			["01", "0000004712", "BG000000001", { "03-30": 12000 }],
		]);
		expect(m.sales).toEqual([]);
		expect(nonZero(m)).toEqual({ "01-30": 12000, "01-31": 10000, "01-41": 2000, "01-40": 2000, "01-60": 2000, "01-80": 2000 });
	});

	it("an exempt fee is outside both journals and listed", () => {
		const m = month([], [stripeFee()]);
		expect(m.purchases).toEqual([]);
		expect(m.unrecorded).toEqual([expect.objectContaining({ side: "received", number: "STRIPE-2026-12", netEur: 295 })]);
		expect(nonZero(m)).toEqual({});
	});

	it("refuses what does not fit its treatment", () => {
		expect(problems([], [awsPurchase({ supplier: { name: "Доставчик", country: "BG", vatNumber: "BG000000002" } })])[0]).toMatch(/no reverse charge/);
		expect(problems([], [bgPurchase({ vatEur: undefined })])[0]).toMatch(/needs vatEur/);
		expect(problems([], [bgPurchase({ supplier: { name: "Доставчик", country: "BG", vatNumber: null } })])[0]).toMatch(/BG VAT number/);
		expect(problems([], [bgPurchase({ supplier: { name: "Foreign", country: "DE", vatNumber: "DE000000000" } })])[0]).toMatch(/rc_services_82_2/);
		expect(problems([], [awsPurchase({ vatEur: "19.00" })])[0]).toMatch(/not 20 %/);
		expect(problems([], [awsPurchase({ kind: "credit_note", amount: "-1.00", netEur: "-1.00" })])[0]).toMatch(/correcting protocol/);
		expect(problems([], [awsPurchase({ taxEventDate: "2027-01-02" })])[0]).toMatch(/outside 2026-12/);
		expect(problems([], [anthropicPurchase({ eurRate: null })])[0]).toMatch(/no eurRate/);
	});

	it("needs each protocol's number when the series is shared with the фактури, and refuses a number used twice", () => {
		expect(problems([], [awsPurchase()], { protocols: { series: "shared_with_factura" } })[0]).toMatch(/protocolNumber must be given/);
		const shared = month([], [awsPurchase({ protocolNumber: "0000000107" })], { protocols: { series: "shared_with_factura" } });
		expect(shared.protocols[0]?.number).toBe("0000000107");
		expect(problems([], [awsPurchase({ protocolNumber: "7" }), anthropicPurchase({ protocolNumber: "7" })])[0]).toMatch(/used twice/);
		expect(problems([], [awsPurchase()], { protocols: { series: "own" } })[0]).toMatch(/no protocols.firstNumber/);
	});

	it("notes a protocol dated more than 15 days after its tax event", () => {
		const m = month([], [anthropicPurchase({ documentDate: "2026-12-01", taxEventDate: "2026-12-01", protocolDate: "2026-12-31" })]);
		expect(m.notes.some((n) => n.includes("more than 15 days"))).toBe(true);
	});
});

describe("the registration's effective date", () => {
	it("leaves documents with an earlier tax event out of the journals, and lists them", () => {
		const m = month([domesticSale({ chargeableDate: "2026-12-03" })], [awsPurchase({ documentDate: "2026-12-05", taxEventDate: "2026-12-05" })], {
			registration: { basis: "chl100", effectiveDate: "2026-12-10" },
		});
		expect(m.sales).toEqual([]);
		expect(m.purchases).toEqual([]);
		expect(m.unrecorded.map((u) => [u.side, u.number])).toEqual([
			["issued", "0000000101"],
			["received", "AWS-0001"],
		]);
	});

	it("refuses a month entirely before it", () => {
		const r = buildNraMonth({ sales: sales([], "2026-11"), input: input() });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.problems[0]).toMatch(/no return for this month/);
	});
});

describe("the input file", () => {
	it("refuses version 1 (the чл. 97а shape with its stripe block)", () => {
		const r = parseNraInput(JSON.stringify({ filer: { vatNumber: FILER_VAT, submitter: "x" }, protocols: { firstNumber: 1 }, stripe: {}, purchases: [] }));
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.problems.join("\n")).toMatch(/version/);
	});

	it("refuses an unknown key and lists every problem with its path", () => {
		const raw = { version: 2, filer: { vatNumber: "BG12", submitter: "x" }, registration: { basis: "chl100", effectiveDate: "2026-12-01" }, protocols: { series: "own" }, extra: 1 };
		const r = parseNraInput(JSON.stringify(raw));
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.problems.join("\n")).toMatch(/filer.vatNumber/);
	});

	it("refuses text that is not JSON", () => {
		const r = parseNraInput("{");
		expect(r.ok).toBe(false);
	});
});

describe("buildSingleProtocol (nra:protocol)", () => {
	const request = (over: Partial<PurchaseFixture> = {}, issueDate?: string) => {
		const i = input([anthropicPurchase(over)]);
		const purchase = i.purchases[0];
		if (!purchase) throw new Error("fixture");
		return { version: 2 as const, filer: { vatNumber: FILER_VAT }, purchase, ...(issueDate ? { issueDate } : {}) };
	};

	it("dates the protocol today, or at the tax event + 15 days when today is later", () => {
		const today = buildSingleProtocol(request(), "12", "2026-12-16");
		expect(today.ok && today.protocol).toMatchObject({ number: "0000000012", issueDate: "2026-12-16", base: 4750, vat: 950 });
		const late = buildSingleProtocol(request(), "12", "2027-01-20");
		expect(late.ok && late.protocol.issueDate).toBe("2026-12-30");
	});

	it("refuses another treatment, a bad number, or a date before the tax event", () => {
		const bg = buildSingleProtocol(request({ treatment: "bg_vat_full_credit", vatEur: "9.50" }), "1", "2026-12-16");
		expect(bg.ok).toBe(false);
		expect(buildSingleProtocol(request(), "0", "2026-12-16").ok).toBe(false);
		expect(buildSingleProtocol(request(), "12345678901", "2026-12-16").ok).toBe(false);
		expect(buildSingleProtocol(request({}, "2026-12-14"), "1", "2026-12-16").ok).toBe(false);
	});
});
