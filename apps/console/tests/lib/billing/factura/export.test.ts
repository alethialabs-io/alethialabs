// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #7369: the accountant's monthly export. The month window is Sofia's calendar month; the documents
// CSV carries every document with EUR columns; the ZIP is a valid stored archive (its CRC matches
// the standard check value, and `unzip -t` reads it where available); the manifest is `sha256sum`
// format over every file and PDF; a document with a missing or altered PDF refuses the export.

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));
vi.mock("@/lib/storage", () => ({ storage: { put: vi.fn(), get: vi.fn() } }));
vi.mock("@/lib/billing/operator-alert", () => ({ alertOperator: vi.fn() }));
import { buildCreditNoteSnapshot } from "@/lib/billing/factura/credit-note";
import {
	type BalanceRow,
	buildExport,
	crc32,
	minorToDecimal,
	monthWindow,
	sha256Hex,
	zipStore,
} from "@/lib/billing/factura/export";
import { buildFacturaSnapshot } from "@/lib/billing/factura/snapshot";
import type { Factura } from "@/lib/db/schema";
import { USD_RATE, paidInvoice } from "./fixtures";

const PDF_1 = new TextEncoder().encode("%PDF-one");
const PDF_2 = new TextEncoder().encode("%PDF-two");

/** The USD фактура 0000000001 and a partial credit note 0000000002 against it, PDFs attached. */
function documents(): Factura[] {
	const original = buildFacturaSnapshot(paidInvoice({ currency: "usd" }), {
		number: "0000000001",
		issueDate: "2027-01-16",
		chargeableDate: "2027-01-15",
		noVatGround: "чл. 113, ал. 9 ЗДДС",
		eurRate: USD_RATE,
	});
	const base = {
		organizationId: "org_1",
		stripeInvoiceId: "in_test_1",
		createdAt: new Date(0),
		pdfKey: "k",
	};
	return [
		{
			...base,
			id: "f2",
			number: "0000000002",
			kind: "credit_note",
			originalFacturaId: "f1",
			stripeRefundId: "re_1",
			issueDate: "2027-01-21",
			chargeableDate: "2027-01-20",
			snapshot: buildCreditNoteSnapshot(original, 1000, {
				number: "0000000002",
				issueDate: "2027-01-21",
				chargeableDate: "2027-01-20",
			}),
			pdfSha256: sha256Hex(PDF_2),
		},
		{
			...base,
			id: "f1",
			number: "0000000001",
			kind: "invoice",
			originalFacturaId: null,
			stripeRefundId: null,
			issueDate: "2027-01-16",
			chargeableDate: "2027-01-15",
			snapshot: original,
			pdfSha256: sha256Hex(PDF_1),
		},
	];
}

const BALANCE: BalanceRow[] = [
	{
		id: "txn_1",
		created: Date.UTC(2027, 0, 15, 9) / 1000,
		availableOn: Date.UTC(2027, 0, 22) / 1000,
		type: "charge",
		reportingCategory: "charge",
		description: "Invoice OQDLWV3B-0031",
		currency: "usd",
		amount: 5500,
		fee: 190,
		net: 5310,
		source: "ch_1",
		payoutId: "po_1",
	},
];

/** The text of a CSV export file, without its byte-order mark. */
function text(data: Uint8Array): string {
	return new TextDecoder().decode(data).replace(/^﻿/, "");
}

describe("monthWindow", () => {
	it("is Sofia's calendar month: midnight at UTC+2 in winter and UTC+3 in summer", () => {
		const jan = monthWindow("2027-01");
		expect(jan).toMatchObject({ firstDay: "2027-01-01", lastDay: "2027-01-31" });
		expect(new Date(jan.startEpoch * 1000).toISOString()).toBe("2026-12-31T22:00:00.000Z");
		expect(new Date(jan.endEpoch * 1000).toISOString()).toBe("2027-01-31T22:00:00.000Z");
		const jul = monthWindow("2027-07");
		expect(new Date(jul.startEpoch * 1000).toISOString()).toBe("2027-06-30T21:00:00.000Z");
		expect(monthWindow("2028-02").lastDay).toBe("2028-02-29");
		expect(monthWindow("2026-12").endEpoch).toBe(monthWindow("2027-01").startEpoch);
	});

	it("refuses anything but YYYY-MM", () => {
		expect(() => monthWindow("2027-13")).toThrow("YYYY-MM");
		expect(() => monthWindow("12-2026")).toThrow("YYYY-MM");
	});
});

describe("minorToDecimal", () => {
	it("prints major units without floats, signed, and zero-decimal currencies as they are", () => {
		expect(minorToDecimal(5500, "usd")).toBe("55.00");
		expect(minorToDecimal(-920, "EUR")).toBe("-9.20");
		expect(minorToDecimal(5, "eur")).toBe("0.05");
		expect(minorToDecimal(1200, "jpy")).toBe("1200");
	});
});

describe("zipStore", () => {
	it("computes the standard CRC-32", () => {
		expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
	});

	it("writes an archive unzip reads back intact, with UTF-8 names", () => {
		const zip = zipStore([
			{ name: "pdfs/0000000001.pdf", data: PDF_1 },
			{ name: "pdfs/фактура.txt", data: PDF_2 },
		]);
		expect(zip.subarray(0, 4)).toEqual(new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
		const dir = mkdtempSync(join(tmpdir(), "factura-zip-"));
		const path = join(dir, "a.zip");
		writeFileSync(path, zip);
		let out: string;
		try {
			out = execFileSync("unzip", ["-t", path], { encoding: "utf8" });
		} catch (err) {
			// No unzip on this machine: the CRC and signature checks above still ran.
			if (err instanceof Error && "code" in err && err.code === "ENOENT") return;
			throw err;
		}
		expect(out).toContain("No errors detected");
	});
});

describe("buildExport", () => {
	const window = monthWindow("2027-01");
	const pdfs = new Map([
		["0000000001", PDF_1],
		["0000000002", PDF_2],
	]);

	it("writes the documents CSV in number order with EUR columns, the ZIP, the Stripe CSV and the manifest", () => {
		const result = buildExport(window, documents(), pdfs, BALANCE);
		if (!result.ok) throw new Error(JSON.stringify(result.problems));
		expect(result.files.map((f) => f.name)).toEqual([
			"facturi-2027-01.csv",
			"facturi-2027-01-pdfs.zip",
			"stripe-balance-2027-01.csv",
			"MANIFEST.sha256",
		]);
		const [docs, , balance, manifest] = result.files;
		const lines = text(docs?.data ?? new Uint8Array()).split("\r\n");
		expect(lines[0]).toMatch(/^number,kind,original_number,/);
		expect(lines[1]).toMatch(/^0000000001,invoice,,,2027-01-16,2027-01-15,Acme GmbH,DE123456789,DE,USD,55\.00,0\.00,55\.00,50\.60,0\.00,0\.92000000,2027-01-14,ECB:2027-01-14,/);
		expect(lines[2]).toMatch(/^0000000002,credit_note,0000000001,2027-01-16,2027-01-21,2027-01-20,.*,USD,-10\.00,0\.00,-10\.00,-9\.20,/);
		expect(lines[2]).toContain("re_1");
		expect(text(balance?.data ?? new Uint8Array()).split("\r\n")[1]).toBe(
			"txn_1,2027-01-15T09:00:00.000Z,2027-01-22T00:00:00.000Z,charge,charge,Invoice OQDLWV3B-0031,USD,55.00,1.90,53.10,ch_1,po_1",
		);
		const manifestLines = new TextDecoder().decode(manifest?.data).trim().split("\n");
		expect(manifestLines).toHaveLength(5);
		expect(manifestLines).toContain(`${sha256Hex(PDF_1)}  pdfs/0000000001.pdf`);
		expect(manifestLines).toContain(`${sha256Hex(docs?.data ?? new Uint8Array())}  facturi-2027-01.csv`);
	});

	it("is reproducible: the same rows give the same bytes", () => {
		const a = buildExport(window, documents(), pdfs, BALANCE);
		const b = buildExport(window, documents(), pdfs, BALANCE);
		if (!a.ok || !b.ok) throw new Error("refused");
		expect(a.files.map((f) => sha256Hex(f.data))).toEqual(b.files.map((f) => sha256Hex(f.data)));
	});

	it("refuses when a PDF is missing, altered, or not yet attached", () => {
		const [creditNote, invoice] = documents();
		if (!creditNote || !invoice) throw new Error("fixture");
		const third: Factura = { ...invoice, id: "f3", number: "0000000003", pdfKey: null, pdfSha256: null };
		const result = buildExport(
			window,
			[creditNote, invoice, third],
			new Map([
				["0000000001", new TextEncoder().encode("%PDF-tampered")],
				["0000000002", null],
			]),
			BALANCE,
		);
		expect(result).toEqual({
			ok: false,
			problems: [
				{ number: "0000000001", problem: "stored PDF does not match its recorded SHA-256" },
				{ number: "0000000002", problem: "PDF missing from storage" },
				{ number: "0000000003", problem: "no PDF attached yet" },
			],
		});
	});
});
