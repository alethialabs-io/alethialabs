// @vitest-environment node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The console's side of the NRA package: the demo month's фактури projected into facturi-M.json
// (sales-documents.ts) with the right treatment for each, the nra/ folder of the export built through
// @repo/nra with the console's PDF renderer, and the files listed in the export's manifest. The
// package's own rules and goldens are tested in packages/nra/tests. Node environment for the PDF.

import { buildNraPackage, type ProtocolRenderer } from "@repo/nra";
import { describe, expect, it } from "vitest";
import { buildExport } from "@/lib/billing/factura/export";
import { demoMonth } from "@/lib/billing/nra/demo";
import { buildNraExport } from "@/lib/billing/nra/package";
import { renderProtocolPdf } from "@/lib/billing/nra/protocol-document";
import { salesFileFromFacturi, salesFileJson } from "@/lib/billing/nra/sales-documents";

/** A stand-in renderer: the protocol number as bytes. */
const stubRender: ProtocolRenderer = async (p) => new TextEncoder().encode(`%PDF-${p.number}`);

/** The demo month with its facturi-M.json. */
function demoSales() {
	const m = demoMonth();
	const sales = salesFileFromFacturi(m.window.month, m.documents);
	if (!sales.ok) throw new Error(sales.problems.join("; "));
	return { ...m, sales: sales.value };
}

describe("salesFileFromFacturi", () => {
	it("classifies each demo document from what is printed on it", () => {
		const { sales } = demoSales();
		expect(sales.documents.map((d) => [d.number, d.kind, d.treatment, d.recipient.vatNumber, d.netEur, d.vatEur])).toEqual([
			["0000000101", "invoice", "bg_vat_20", "BG000000000", "49.00", "9.80"],
			["0000000102", "invoice", "eu_b2b_services_21_2", "DE000000000", "114.00", "0.00"],
			["0000000103", "credit_note", "eu_b2b_services_21_2", "DE000000000", "-28.50", "0.00"],
			["0000000104", "invoice", "outside_eu_69_2", null, "1234.56", "0.00"],
		]);
		expect(sales.documents[1]).toMatchObject({ currency: "USD", amount: "120.00", eurRate: "0.95000000" });
		expect(sales.documents[2]?.original).toEqual({ number: "0000000102", issueDate: "2026-12-10" });
	});

	it("treats a consumer in another member state (no VAT number) as a Bulgarian 20 % supply", () => {
		const m = demoMonth();
		const de = m.documents[1];
		if (!de) throw new Error("fixture");
		const consumer = { ...de, snapshot: { ...de.snapshot, recipient: { ...de.snapshot.recipient, identifiers: [] } } };
		const r = salesFileFromFacturi(m.window.month, [consumer]);
		expect(r.ok && r.value.documents[0]?.treatment).toBe("bg_vat_20");
	});

	it("writes JSON that parses back to the same file", () => {
		const { sales } = demoSales();
		expect(JSON.parse(new TextDecoder().decode(salesFileJson(sales)))).toEqual(sales);
	});
});

describe("buildNraExport", () => {
	it("places the package under nra/ and reports the refundable VAT of the demo month", async () => {
		const { sales, operator } = demoSales();
		const out = await buildNraExport(sales, operator, stubRender, { demo: true });
		if (!out.ok) throw new Error(out.problems.join("; "));
		expect(out.files.map((f) => f.name)).toEqual([
			"nra/DEKLAR.TXT",
			"nra/PRODAGBI.TXT",
			"nra/POKUPKI.TXT",
			"nra/VIES.TXT",
			"nra/protocols/0000000001.pdf",
			"nra/protocols/0000000001.txt",
			"nra/protocols/0000000002.pdf",
			"nra/protocols/0000000002.txt",
			"nra/protocols/0000000003.pdf",
			"nra/protocols/0000000003.txt",
			"nra/SUMMARY.md",
		]);
		// Worked by hand: output 9.80 + 0.76 + 9.50 + 40.36 = 60.42; credit 20.00 + 0.76 + 9.50 + 40.36 = 70.62.
		expect(out.vatPayableCents).toBe(0);
		expect(out.vatRefundableCents).toBe(1020);
	});

	it("is listed in the export's manifest beside facturi-M.json", async () => {
		const { window, sales, operator } = demoSales();
		const nra = await buildNraExport(sales, operator, stubRender, { demo: true });
		if (!nra.ok) throw new Error("refused");
		const out = buildExport(window, [], new Map(), [], [{ name: "facturi-2026-12.json", data: salesFileJson(sales) }, ...nra.files]);
		if (!out.ok) throw new Error("refused");
		const manifest = new TextDecoder().decode(out.files.find((f) => f.name === "MANIFEST.sha256")?.data);
		expect(manifest).toMatch(/^[0-9a-f]{64} {2}facturi-2026-12\.json$/m);
		expect(manifest).toMatch(/^[0-9a-f]{64} {2}nra\/DEKLAR\.TXT$/m);
		expect(manifest).toMatch(/^[0-9a-f]{64} {2}nra\/protocols\/0000000003\.pdf$/m);
	});
});

describe("renderProtocolPdf", () => {
	it("renders a protocol to a reproducible PDF", async () => {
		const { sales, operator } = demoSales();
		const pkg = await buildNraPackage(sales, operator, null);
		if (!pkg.ok) throw new Error(pkg.problems.join("; "));
		const [first] = pkg.month.protocols;
		if (!first) throw new Error("fixture");
		const a = await renderProtocolPdf(first, operator.filer.vatNumber);
		const b = await renderProtocolPdf(first, operator.filer.vatNumber);
		expect(new TextDecoder().decode(a.subarray(0, 5))).toBe("%PDF-");
		expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
	}, 30_000);
});
