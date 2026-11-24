// @vitest-environment node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #7457: the nra/ package as the export writes it — file names, the protocols (golden text, and a
// real PDF rendered with the фактура's renderer and fonts), SUMMARY.md (golden), the due date, and
// that a refusal anywhere returns problems and no files. Node environment for the PDF, as in
// tests/lib/billing/factura/render.test.ts.

import { describe, expect, it } from "vitest";
import { buildExport } from "@/lib/billing/factura/export";
import { demoMonth } from "@/lib/billing/nra/demo";
import { buildNraMonth } from "@/lib/billing/nra/month";
import { buildNraPackage, type ProtocolRenderer } from "@/lib/billing/nra/package";
import { protocolLayout, protocolText } from "@/lib/billing/nra/protocol";
import { renderProtocolPdf } from "@/lib/billing/nra/protocol-document";
import { ACCOUNTANT_QUESTIONS, dueDate } from "@/lib/billing/nra/summary";

/** A stand-in renderer: the protocol number as bytes. */
const stubRender: ProtocolRenderer = async (p) => new TextEncoder().encode(`%PDF-${p.number}`);

/** The demo month's protocols. */
function protocols() {
	const r = buildNraMonth(demoMonth());
	if (!r.ok) throw new Error(r.problems.join("; "));
	return r.month.protocols;
}

describe("dueDate", () => {
	it("is the 14th of the next month, across a year end", () => {
		expect(dueDate("2026-12")).toBe("2027-01-14");
		expect(dueDate("2027-01")).toBe("2027-02-14");
	});
});

describe("the protocols", () => {
	it("print every point of чл. 117, ал. 2 ЗДДС, as golden/protocol-*.txt", async () => {
		const [stripe, google, anthropic] = protocols();
		if (!stripe || !google || !anthropic) throw new Error("fixture");
		await expect(`${protocolText(protocolLayout(stripe, "BG208913663"))}\n`).toMatchFileSnapshot("./golden/protocol-stripe.txt");
		await expect(`${protocolText(protocolLayout(anthropic, "BG208913663"))}\n`).toMatchFileSnapshot("./golden/protocol-anthropic.txt");
		const text = protocolText(protocolLayout(google, "BG208913663"));
		for (const part of ["№ 0000000002", "16.12.2026", "01.12.2026", "ДДС № / VAT No.: BG208913663", "IE0000001XX", "DEMO-GW-5550001", "€6.80", "20 %", "€1.36", "чл. 82, ал. 2, т. 3 ЗДДС"]) {
			expect(text).toContain(part);
		}
	});

	it("say so when the supplier's invoice was not issued by the protocol date", () => {
		const [stripe] = protocols();
		if (!stripe) throw new Error("fixture");
		expect(protocolText(protocolLayout({ ...stripe, supplierDocument: null }, "BG208913663"))).toContain("не е издадена към датата на протокола");
	});

	it("render to a reproducible PDF", async () => {
		const [google] = protocols().slice(1);
		if (!google) throw new Error("fixture");
		const a = await renderProtocolPdf(google, "BG208913663");
		const b = await renderProtocolPdf(google, "BG208913663");
		expect(new TextDecoder().decode(a.subarray(0, 5))).toBe("%PDF-");
		expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
	}, 30_000);
});

describe("buildNraPackage", () => {
	it("writes the four files, a PDF and a .txt per protocol, and SUMMARY.md, under nra/", async () => {
		const pkg = await buildNraPackage(demoMonth(), stubRender, { demo: true });
		if (!pkg.ok) throw new Error(pkg.problems.join("; "));
		expect(pkg.files.map((f) => f.name)).toEqual([
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
		expect(pkg.vatPayableCents).toBe(1063);
	});

	it("writes SUMMARY.md as golden/SUMMARY.md, demo banner first", async () => {
		const pkg = await buildNraPackage(demoMonth(), stubRender, { demo: true });
		if (!pkg.ok) throw new Error("refused");
		const summary = new TextDecoder().decode(pkg.files.find((f) => f.name === "nra/SUMMARY.md")?.data);
		expect(summary.startsWith("> **DEMO.")).toBe(true);
		for (const q of ACCOUNTANT_QUESTIONS) expect(summary).toContain(q);
		await expect(summary).toMatchFileSnapshot("./golden/SUMMARY.md");
	});

	it("summarises a nil month, without the demo banner", async () => {
		const m = demoMonth();
		const pkg = await buildNraPackage({ ...m, documents: [], balance: [], operator: { ...m.operator, purchases: [], stripe: undefined } }, stubRender);
		if (!pkg.ok) throw new Error("refused");
		const summary = new TextDecoder().decode(pkg.files.find((f) => f.name === "nra/SUMMARY.md")?.data);
		expect(summary).not.toContain("DEMO");
		expect(summary).toContain("**Nil month.**");
		expect(summary).toContain("VAT payable (cell 50): EUR 0.00");
		expect(summary).toContain("not filed this month");
		expect(pkg.files.map((f) => f.name)).toEqual(["nra/DEKLAR.TXT", "nra/PRODAGBI.TXT", "nra/POKUPKI.TXT", "nra/SUMMARY.md"]);
	});

	it("lists notes in the summary: a late protocol and fitted text", async () => {
		const m = demoMonth();
		const pkg = await buildNraPackage({ ...m, operator: { ...m.operator, protocols: { firstNumber: 1, issueDate: "2026-12-31" } } }, stubRender);
		if (!pkg.ok) throw new Error("refused");
		const summary = new TextDecoder().decode(pkg.files.find((f) => f.name === "nra/SUMMARY.md")?.data);
		expect(summary).toContain("## Notes");
		expect(summary).toContain("more than 15 days after the tax event");
	});

	it("returns problems and no files when the month refuses", async () => {
		const m = demoMonth();
		expect(await buildNraPackage({ ...m, operator: { ...m.operator, stripe: undefined } }, stubRender)).toEqual({
			ok: false,
			problems: [expect.stringContaining("stripe.processingFees"), expect.stringContaining("stripe block")],
		});
	});

	it("returns problems when text cannot be written in cp-1251", async () => {
		const m = demoMonth();
		const p = m.operator.purchases[0];
		if (!p) throw new Error("fixture");
		const pkg = await buildNraPackage({ ...m, operator: { ...m.operator, purchases: [{ ...p, description: "☃ snow service" }] } }, stubRender);
		expect(pkg).toEqual({ ok: false, problems: [expect.stringContaining("cannot be written in cp-1251")] });
	});

	it("is listed in the export's manifest beside the other files", async () => {
		const m = demoMonth();
		const pkg = await buildNraPackage({ ...m, documents: [] }, stubRender);
		if (!pkg.ok) throw new Error("refused");
		const out = buildExport(m.window, [], new Map(), m.balance, pkg.files);
		if (!out.ok) throw new Error("refused");
		const manifest = new TextDecoder().decode(out.files.find((f) => f.name === "MANIFEST.sha256")?.data);
		expect(manifest).toMatch(/^[0-9a-f]{64} {2}nra\/DEKLAR\.TXT$/m);
		expect(manifest).toMatch(/^[0-9a-f]{64} {2}nra\/protocols\/0000000003\.pdf$/m);
		expect(manifest).toMatch(/^[0-9a-f]{64} {2}nra\/SUMMARY\.md$/m);
		expect(out.files.map((f) => f.name)).toContain("nra/POKUPKI.TXT");
	});
});
