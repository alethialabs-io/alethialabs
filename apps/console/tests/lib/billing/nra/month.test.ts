// @vitest-environment node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #7457: which document goes in which journal for a чл. 97а-only company, the чл. 117 protocols, the
// VIES lines, and every refusal. Built on the demo month (lib/billing/nra/demo.ts) with one change
// per test, so each rule is checked against a known whole.

import { describe, expect, it } from "vitest";
import type { BalanceRow } from "@/lib/billing/factura/export";
import { demoMonth } from "@/lib/billing/nra/demo";
import { eurToCents, parseNraInput } from "@/lib/billing/nra/input";
import { buildNraMonth, NO_EU_VAT_ID, type NraMonthInput, stripeFees, vatOf } from "@/lib/billing/nra/month";
import type { Factura } from "@/lib/db/schema";

/** The demo month's input, with `over` applied. */
function input(over: (i: NraMonthInput) => NraMonthInput = (i) => i): NraMonthInput {
	return over(demoMonth());
}

/** The built month, or a failure with its problems. */
function build(i: NraMonthInput) {
	const r = buildNraMonth(i);
	if (!r.ok) throw new Error(r.problems.join("; "));
	return r.month;
}

/** The problems of a month that must refuse. */
function problems(i: NraMonthInput): string[] {
	const r = buildNraMonth(i);
	if (r.ok) throw new Error("expected a refusal");
	return r.problems;
}

/** A copy of `doc` with the recipient changed. */
function withRecipient(doc: Factura, country: string, ids: { label: string; value: string }[]): Factura {
	return { ...doc, snapshot: { ...doc.snapshot, recipient: { ...doc.snapshot.recipient, country, identifiers: ids } } };
}

describe("vatOf", () => {
	it("is 20 % rounded half away from zero to the cent", () => {
		expect(vatOf(419)).toBe(84);
		expect(vatOf(680)).toBe(136);
		expect(vatOf(4217)).toBe(843);
		expect(vatOf(2)).toBe(0);
		expect(vatOf(3)).toBe(1);
		expect(vatOf(-3)).toBe(-1);
		expect(vatOf(0)).toBe(0);
	});
});

describe("buildNraMonth: sales", () => {
	it("leaves the Bulgarian фактура out of the journals, with the чл. 113, ал. 9 reason", () => {
		const m = build(input());
		expect(m.sales.map((s) => s.number)).not.toContain("0000000101");
		expect(m.excluded).toEqual([
			expect.objectContaining({ number: "0000000101", country: "BG", baseEur: 4900, reason: expect.stringContaining("чл. 113, ал. 9") }),
		]);
	});

	it("records the EU B2B фактура (01) and its credit note (03) in 02-17 at their EUR amounts", () => {
		const m = build(input());
		const eu = m.sales.filter((s) => s.euServiceBase !== 0);
		expect(eu).toEqual([
			expect.objectContaining({ docType: "01", number: "0000000102", date: "2026-12-10", counterpartyId: "DE000000000", euServiceBase: 11400, reverseChargeBase: 0 }),
			expect.objectContaining({ docType: "03", number: "0000000103", date: "2026-12-18", counterpartyId: "DE000000000", euServiceBase: -2850 }),
		]);
	});

	it("nets the customer's VIES line over the фактура and the credit note", () => {
		expect(build(input()).vies).toEqual([{ vatNumber: "DE000000000", servicesBase: 8550, period: "2026-12" }]);
	});

	it("leaves out an EU customer with no VAT number, a non-EU customer, and a VAT number of another state", () => {
		const m = build(
			input((i) => {
				const [, de, credit] = i.documents;
				if (!de || !credit) throw new Error("fixture");
				return {
					...i,
					documents: [withRecipient(de, "FR", []), withRecipient(credit, "US", [{ label: "Tax ID", value: "12-3456789" }])],
					operator: { ...i.operator, vies: undefined },
				};
			}),
		);
		expect(m.sales.filter((s) => s.docType !== "09")).toEqual([]);
		expect(m.vies).toEqual([]);
		expect(m.excluded.map((x) => x.reason)).toEqual([
			expect.stringContaining("чл. 21, ал. 2"),
			expect.stringContaining("чл. 21, ал. 2"),
		]);
		const mismatch = build(
			input((i) => {
				const de = i.documents[1];
				if (!de) throw new Error("fixture");
				return { ...i, documents: [withRecipient(de, "AT", [{ label: "VAT", value: "DE000000000" }])], operator: { ...i.operator, vies: undefined } };
			}),
		);
		expect(mismatch.excluded).toHaveLength(1);
	});

	it("writes a Greek customer's number with the EL prefix", () => {
		const m = build(
			input((i) => {
				const de = i.documents[1];
				if (!de) throw new Error("fixture");
				return { ...i, documents: [withRecipient(de, "GR", [{ label: "VAT", value: "GR123456789" }])] };
			}),
		);
		expect(m.vies[0]?.vatNumber).toBe("EL123456789");
	});

	it("puts a document chargeable in an earlier month on a VIES line for that month", () => {
		const m = build(
			input((i) => {
				const de = i.documents[1];
				if (!de) throw new Error("fixture");
				return { ...i, documents: [{ ...de, chargeableDate: "2026-11-30" }] };
			}),
		);
		expect(m.vies).toEqual([{ vatNumber: "DE000000000", servicesBase: 11400, period: "2026-11" }]);
	});

	it("refuses a non-EUR document without its EUR equivalent", () => {
		const p = problems(
			input((i) => {
				const de = i.documents[1];
				if (!de) throw new Error("fixture");
				return { ...i, documents: [{ ...de, snapshot: { ...de.snapshot, eurEquivalent: null } }] };
			}),
		);
		expect(p).toEqual(["0000000102: in USD with no EUR equivalent on the document"]);
	});

	it("refuses a month with EU sales and no VIES block", () => {
		expect(problems(input((i) => ({ ...i, operator: { ...i.operator, vies: undefined } })))).toEqual([
			expect.stringContaining("add the vies block"),
		]);
	});
});

describe("buildNraMonth: protocols", () => {
	it("issues one numbered protocol for Stripe's month and one per listed invoice, Stripe first", () => {
		const m = build(input());
		expect(m.protocols.map((p) => [p.number, p.supplier.name, p.base, p.vat, p.taxEventDate, p.issueDate])).toEqual([
			["0000000001", "Stripe Payments Europe, Limited", 419, 84, "2026-12-31", "2026-12-31"],
			["0000000002", "Google Cloud EMEA Limited", 680, 136, "2026-12-01", "2026-12-16"],
			["0000000003", "Anthropic, PBC", 4217, 843, "2026-12-15", "2026-12-30"],
		]);
		expect(m.notes).toEqual([]);
	});

	it("records each protocol in the sales journal (02-26, 02-22) and the purchase journal (03-30 = base + tax)", () => {
		const m = build(input());
		const google = m.sales.find((s) => s.number === "0000000002");
		expect(google).toMatchObject({ docType: "09", counterpartyId: "IE0000001XX", reverseChargeBase: 680, reverseChargeVat: 136, euServiceBase: 0 });
		expect(m.purchases.map((p) => [p.number, p.counterpartyId, p.noCreditBaseAndVat])).toEqual([
			["0000000001", "IE0000000XX", 503],
			["0000000002", "IE0000001XX", 816],
			["0000000003", NO_EU_VAT_ID, 5060],
		]);
	});

	it("orders the sales journal by date, then type, then number", () => {
		expect(build(input()).sales.map((s) => s.number)).toEqual(["0000000102", "0000000002", "0000000103", "0000000003", "0000000001"]);
	});

	it("continues the series from protocols.firstNumber", () => {
		const m = build(input((i) => ({ ...i, operator: { ...i.operator, protocols: { firstNumber: 41 } } })));
		expect(m.protocols.map((p) => p.number)).toEqual(["0000000041", "0000000042", "0000000043"]);
	});

	it("uses a fixed protocols.issueDate, notes one later than 15 days, and refuses one outside the month", () => {
		const m = build(input((i) => ({ ...i, operator: { ...i.operator, protocols: { firstNumber: 1, issueDate: "2026-12-31" } } })));
		expect(m.protocols.every((p) => p.issueDate === "2026-12-31")).toBe(true);
		expect(m.notes).toEqual([
			expect.stringContaining("0000000002 (Google Cloud EMEA Limited) is dated 2026-12-31"),
			expect.stringContaining("0000000003 (Anthropic, PBC) is dated 2026-12-31, more than 15 days after the tax event 2026-12-15"),
		]);
		expect(problems(input((i) => ({ ...i, operator: { ...i.operator, protocols: { firstNumber: 1, issueDate: "2027-01-02" } } })))).toEqual([
			"protocols.issueDate 2027-01-02 is outside 2026-12",
		]);
	});

	it("refuses a purchase whose tax event is in another month, and a Bulgarian supplier", () => {
		const p = problems(
			input((i) => ({
				...i,
				operator: {
					...i.operator,
					purchases: [
						{ supplier: { name: "Late", country: "IE", vatNumber: "IE1234567X" }, documentNumber: "1", documentDate: "2026-11-30", description: "x", netEur: "1" },
						{ supplier: { name: "Local", country: "BG", vatNumber: "BG123456789" }, documentNumber: "2", documentDate: "2026-12-02", description: "y", netEur: "1" },
						{ supplier: { name: "Local2", country: "BG", vatNumber: null }, documentNumber: "3", documentDate: "2026-12-02", description: "z", netEur: "1" },
					],
				},
			})),
		);
		expect(p).toEqual([
			expect.stringContaining("Late 1: tax event 2026-11-30 is outside 2026-12"),
			expect.stringContaining("Local: a Bulgarian supplier"),
			expect.stringContaining("Local2: a Bulgarian supplier"),
		]);
	});

	it("uses the tax event date over the invoice date when given, and the 999… id for a non-EU number", () => {
		const m = build(
			input((i) => ({
				...i,
				balance: [],
				operator: {
					...i.operator,
					purchases: [
						{ supplier: { name: "UK Ltd", country: "GB", vatNumber: "GB123456789" }, documentNumber: "9", documentDate: "2026-11-28", taxEventDate: "2026-12-05", description: "svc", netEur: "10.5" },
					],
				},
			})),
		);
		expect(m.protocols).toEqual([expect.objectContaining({ taxEventDate: "2026-12-05", base: 1050, vat: 210, supplierDocument: { number: "9", date: "2026-11-28" } })]);
		expect(m.purchases[0]?.counterpartyId).toBe(NO_EU_VAT_ID);
	});
});

describe("Stripe fees", () => {
	/** A balance row. */
	function row(over: Partial<BalanceRow> & Pick<BalanceRow, "id" | "type">): BalanceRow {
		return { created: 0, availableOn: 0, reportingCategory: "fee", description: null, currency: "eur", amount: 0, fee: 0, net: 0, source: null, payoutId: null, ...over };
	}

	it("splits software fees (stripe_fee, tax_fee) from processing fees on charges", () => {
		const r = stripeFees(
			[row({ id: "a", type: "stripe_fee", amount: -100 }), row({ id: "b", type: "tax_fee", amount: -20 }), row({ id: "c", type: "charge", amount: 5000, fee: 75 }), row({ id: "d", type: "payout", amount: -4000 })],
			"exempt",
		);
		expect(r).toEqual({ ok: true, fees: { software: 120, processing: 75, processingTreatment: "exempt" } });
	});

	it("has no treatment to record when there are no processing fees", () => {
		expect(stripeFees([row({ id: "a", type: "stripe_fee", amount: -100 })], "taxable")).toEqual({
			ok: true,
			fees: { software: 100, processing: 0, processingTreatment: null },
		});
	});

	it("refuses a fee in a currency other than EUR", () => {
		expect(stripeFees([row({ id: "x", type: "charge", fee: 10, currency: "usd" })], "taxable")).toEqual({ ok: false, problem: expect.stringContaining("x is in USD") });
	});

	it("leaves exempt processing fees out of the Stripe protocol", () => {
		const m = build(input((i) => ({ ...i, operator: { ...i.operator, stripe: i.operator.stripe ? { ...i.operator.stripe, processingFees: "exempt" } : undefined } })));
		expect(m.protocols[0]).toMatchObject({ base: 124, lines: [expect.objectContaining({ base: 124 })] });
		expect(m.stripe).toEqual({ software: 124, processing: 295, processingTreatment: "exempt" });
	});

	it("refuses Stripe fees with no stripe block, and a currency it cannot self-charge", () => {
		expect(problems(input((i) => ({ ...i, operator: { ...i.operator, stripe: undefined } })))).toEqual([
			expect.stringContaining("set stripe.processingFees"),
			expect.stringContaining("add the stripe block"),
		]);
		expect(problems(input((i) => ({ ...i, balance: i.balance.map((b) => ({ ...b, currency: "usd" })) })))).toEqual([expect.stringContaining("in USD")]);
	});

	it("issues no Stripe protocol in a month with no Stripe fees", () => {
		const m = build(input((i) => ({ ...i, balance: [] })));
		expect(m.protocols.map((p) => p.supplier.name)).toEqual(["Google Cloud EMEA Limited", "Anthropic, PBC"]);
	});
});

describe("the input file", () => {
	it("parses amounts to exact cents", () => {
		expect(eurToCents("12")).toBe(1200);
		expect(eurToCents("12.5")).toBe(1250);
		expect(eurToCents("0.07")).toBe(7);
		expect(eurToCents("-3.10")).toBe(-310);
		expect(() => eurToCents("1.234")).toThrow();
	});

	it("accepts the demo input and lists every problem of a bad one with its path", () => {
		expect(parseNraInput(JSON.stringify(demoMonth().operator))).toEqual({ ok: true, input: demoMonth().operator });
		const bad = parseNraInput(JSON.stringify({ filer: { vatNumber: "208913663", submitter: "" }, protocols: { firstNumber: 0 }, purchases: [{ netEur: 5 }] }));
		expect(bad).toEqual({
			ok: false,
			problems: expect.arrayContaining([
				expect.stringMatching(/^filer\.vatNumber: BG followed/),
				expect.stringMatching(/^protocols\.firstNumber/),
				expect.stringMatching(/^purchases\.0\./),
			]),
		});
		expect(parseNraInput("{nope")).toEqual({ ok: false, problems: [expect.stringContaining("not JSON")] });
	});

	it("defaults purchases to none", () => {
		const r = parseNraInput(JSON.stringify({ filer: { vatNumber: "BG208913663", submitter: "x" }, protocols: { firstNumber: 1 } }));
		expect(r.ok && r.input.purchases).toEqual([]);
	});
});
