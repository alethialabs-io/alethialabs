// @vitest-environment node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #7368: the golden render of an EUR and a USD фактура. The text half compares every printed string,
// in order, against golden/factura-{eur,usd}.txt: the PDF component prints the layout's strings and
// nothing else, so a change to what the document says shows up as a diff of those files. The byte
// half renders the real PDF with the vendored Cyrillic font and checks it is a PDF and that the same
// snapshot renders the same bytes, which is what the SHA-256 stored beside each row relies on.
//
// It runs in the node environment on purpose: under jsdom, @react-pdf resolves its browser build,
// whose output here was a file that starts with %PDF- and does not open (a corrupt deflate stream).
// The console renders on the server, in Node, so that is the build under test; `inflatesCleanly`
// is the check that would have caught the corrupt file.
//
// An intended change to the document: update the golden file in the same PR and review its diff.

import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { renderFacturaPdf } from "@/lib/billing/factura/document";
import { facturaLayout, layoutText } from "@/lib/billing/factura/layout";
import { buildFacturaSnapshot } from "@/lib/billing/factura/snapshot";
import { USD_RATE, paidInvoice } from "./fixtures";

/** The snapshot of фактура 0000000001 for the fixture invoice in `currency`. */
function snapshotIn(currency: "eur" | "usd") {
	return buildFacturaSnapshot(paidInvoice({ currency }), {
		number: "0000000001",
		issueDate: "2027-01-16",
		chargeableDate: "2027-01-15",
		noVatGround: "чл. 113, ал. 9 ЗДДС",
		eurRate: currency === "usd" ? USD_RATE : null,
	});
}

/**
 * True when every compressed stream in the PDF inflates. A PDF whose streams do not decode will not
 * open, however its first bytes look.
 */
function inflatesCleanly(pdf: Uint8Array): { streams: number; ok: boolean } {
	const buf = Buffer.from(pdf);
	let streams = 0;
	let at = 0;
	for (;;) {
		const dict = buf.indexOf("/FlateDecode", at);
		if (dict < 0) break;
		const start = buf.indexOf("stream", dict);
		const end = buf.indexOf("endstream", start);
		if (start < 0 || end < 0) return { streams, ok: false };
		const bodyStart = start + "stream".length + (buf[start + 6] === 0x0d ? 2 : 1);
		try {
			inflateSync(buf.subarray(bodyStart, end), { finishFlush: 2 });
		} catch {
			return { streams, ok: false };
		}
		streams++;
		at = end;
	}
	return { streams, ok: true };
}

/** Lower-case hex SHA-256. */
function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

describe("фактура golden render", () => {
	it("prints the EUR фактура exactly as golden/factura-eur.txt, with no conversion block", async () => {
		const text = layoutText(facturaLayout(snapshotIn("eur")));
		await expect(`${text}\n`).toMatchFileSnapshot("./golden/factura-eur.txt");
		expect(text).not.toContain("Курс");
	});

	it("prints the USD фактура exactly as golden/factura-usd.txt, with the EUR equivalent and rate", async () => {
		const text = layoutText(facturaLayout(snapshotIn("usd")));
		await expect(`${text}\n`).toMatchFileSnapshot("./golden/factura-usd.txt");
		expect(text).toContain("Данъчна основа в EUR / Taxable amount in EUR: €50.60");
	});

	it("renders a PDF, and the same snapshot renders the same bytes", async () => {
		for (const currency of ["eur", "usd"] as const) {
			const a = await renderFacturaPdf(snapshotIn(currency));
			const b = await renderFacturaPdf(snapshotIn(currency));
			expect(new TextDecoder().decode(a.subarray(0, 5))).toBe("%PDF-");
			expect(new TextDecoder().decode(a.subarray(-6)).trim()).toBe("%%EOF");
			const check = inflatesCleanly(a);
			expect(check.ok).toBe(true);
			expect(check.streams).toBeGreaterThan(2);
			expect(sha256(a)).toBe(sha256(b));
		}
	}, 30_000);

	it("renders different bytes for a different фактура", async () => {
		const eur = await renderFacturaPdf(snapshotIn("eur"));
		const usd = await renderFacturaPdf(snapshotIn("usd"));
		expect(sha256(eur)).not.toBe(sha256(usd));
	}, 30_000);
});
