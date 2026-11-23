// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #7368: the order of writes when the console issues a фактура. Checks and the EUR rate come before
// a number is taken; the number and snapshot are saved together; the PDF is rendered, stored and
// attached after; a replay finds the issued row instead of issuing again; a lost race returns the
// winner's row; a PDF failure leaves the фактура issued and a replay finishes it. The database is an
// in-memory store here; tests/integration/factura-issue.test.ts runs the real one.

import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));
vi.mock("@/lib/storage", () => ({ storage: { put: vi.fn(), get: vi.fn() } }));

import {
	type FacturaPdfStorage,
	type FacturaStore,
	type IssueDeps,
	issuedFacturaFor,
	requestFactura,
	sofiaDay,
} from "@/lib/billing/factura/issue";
import type { Factura, FacturaInsert } from "@/lib/db/schema";
import { PAID_AT, USD_RATE, paidInvoice } from "./fixtures";

/** An in-memory store with a gap-free counter, recording every number it hands out. */
function memoryStore(): FacturaStore & { rows: Factura[]; last: number } {
	const rows: Factura[] = [];
	const store = {
		rows,
		last: 0,
		async findIssued(id: string) {
			return rows.find((r) => r.stripeInvoiceId === id && r.kind === "invoice") ?? null;
		},
		async issue(build: (n: string) => FacturaInsert) {
			const next = store.last + 1;
			const insert = build(String(next).padStart(10, "0"));
			if (rows.some((r) => r.stripeInvoiceId === insert.stripeInvoiceId && r.kind === insert.kind)) return null;
			store.last = next;
			const row: Factura = {
				id: `f${next}`,
				organizationId: insert.organizationId,
				number: insert.number,
				kind: insert.kind,
				originalFacturaId: null,
				stripeInvoiceId: insert.stripeInvoiceId,
				issueDate: insert.issueDate,
				chargeableDate: insert.chargeableDate,
				snapshot: insert.snapshot,
				pdfKey: null,
				pdfSha256: null,
				createdAt: new Date(),
			};
			rows.push(row);
			return row;
		},
		async attachPdf(id: string, key: string, sha: string) {
			const row = rows.find((r) => r.id === id);
			if (row && !row.pdfKey) Object.assign(row, { pdfKey: key, pdfSha256: sha });
		},
	};
	return store;
}

/** An in-memory object store. */
function memoryStorage(): FacturaPdfStorage & { objects: Map<string, Uint8Array> } {
	const objects = new Map<string, Uint8Array>();
	return {
		objects,
		async put(_b, key, body) {
			objects.set(key, body);
		},
		async get(_b, key) {
			return objects.get(key) ?? null;
		},
	};
}

/** A renderer whose bytes depend only on the snapshot's number, like the real one on the snapshot. */
const render = vi.fn(async (s: { number: string }) => new TextEncoder().encode(`%PDF ${s.number}`));

/** Test dependencies: memory store and storage, a fixed rate, the clock at 2027-01-16. */
function deps(over: Partial<Omit<IssueDeps, "store" | "pdfStorage">> = {}) {
	return {
		store: memoryStore(),
		pdfStorage: memoryStorage(),
		rateLookup: vi.fn(async () => USD_RATE),
		render,
		supplier: { vatRegistered: false },
		now: () => new Date(Date.UTC(2027, 0, 16, 10, 0, 0)),
		...over,
	};
}

const ORG = "00000000-0000-4000-8000-000000000001";

describe("requestFactura", () => {
	it("issues an EUR фактура: number, snapshot, PDF stored and attached with its hash", async () => {
		const d = deps();
		const out = await requestFactura(paidInvoice(), ORG, d);
		expect(out.ok).toBe(true);
		if (!out.ok) return;
		expect(out.factura.number).toBe("0000000001");
		expect(out.factura.vatGround).toBe("чл. 113, ал. 9 ЗДДС");
		const [row] = d.store.rows;
		expect(row.issueDate).toBe("2027-01-16");
		expect(row.chargeableDate).toBe("2027-01-15");
		expect(row.snapshot.eurEquivalent).toBeNull();
		expect(row.pdfKey).toBe(`${ORG}/in_test_1.pdf`);
		expect(row.pdfSha256).toBe(createHash("sha256").update(out.factura.pdf).digest("hex"));
		expect(d.pdfStorage.objects.get(row.pdfKey ?? "")).toEqual(out.factura.pdf);
		expect(d.rateLookup).not.toHaveBeenCalled();
	});

	it("issues a USD фактура with the EUR equivalent at the ECB rate of the payment date", async () => {
		const d = deps();
		const out = await requestFactura(paidInvoice({ id: "in_usd", currency: "usd" }), ORG, d);
		expect(out.ok).toBe(true);
		expect(d.rateLookup).toHaveBeenCalledWith("usd", new Date(PAID_AT * 1000));
		expect(d.store.rows[0].snapshot.eurEquivalent).toEqual({
			taxBaseEurMinor: 5060,
			vatEurMinor: 0,
			rate: "0.92000000",
			rateDate: "2027-01-14",
			source: "ECB:2027-01-14",
		});
	});

	it("takes no number when no rate can be had", async () => {
		const d = deps({ rateLookup: vi.fn(async () => null) });
		const out = await requestFactura(paidInvoice({ id: "in_norate", currency: "usd" }), ORG, d);
		expect(out).toMatchObject({ ok: false, reason: "no_rate" });
		expect(d.store.last).toBe(0);
	});

	it("takes no number for an incomplete recipient, a registered supplier, or a taxed invoice", async () => {
		const d = deps();
		expect(await requestFactura(paidInvoice({ id: "a", customer_tax_ids: [] }), ORG, d)).toMatchObject({
			ok: false,
			reason: "recipient_incomplete",
		});
		expect(
			await requestFactura(paidInvoice({ id: "b" }), ORG, { ...d, supplier: { vatRegistered: true } }),
		).toMatchObject({ ok: false, reason: "no_ground_ruling" });
		expect(await requestFactura(paidInvoice({ id: "c", total: 6600 }), ORG, d)).toMatchObject({
			ok: false,
			reason: "vat_charged",
		});
		expect(d.store.last).toBe(0);
	});

	it("refuses an invoice with no id", async () => {
		expect(await requestFactura(paidInvoice({ id: undefined }), ORG, deps())).toMatchObject({
			ok: false,
			reason: "no_invoice_id",
		});
	});

	it("is idempotent: a replay returns the issued фактура and takes no second number", async () => {
		const d = deps();
		const first = await requestFactura(paidInvoice(), ORG, d);
		const again = await requestFactura(paidInvoice(), ORG, d);
		expect(again).toEqual(first);
		expect(d.store.last).toBe(1);
	});

	it("returns the winner's row when another issuer inserted first", async () => {
		const d = deps();
		const winner = memoryStore();
		await requestFactura(paidInvoice(), ORG, { ...d, store: winner });
		// The loser saw no row, then lost the insert.
		let looked = false;
		const loser: FacturaStore = {
			findIssued: async (id) => {
				if (!looked) {
					looked = true;
					return null;
				}
				return winner.findIssued(id);
			},
			issue: async () => null,
			attachPdf: winner.attachPdf,
		};
		const out = await requestFactura(paidInvoice(), ORG, { ...d, store: loser, pdfStorage: d.pdfStorage });
		expect(out).toMatchObject({ ok: true, factura: { number: "0000000001" } });
	});

	it("leaves the фактура issued when the PDF fails, and a replay renders and attaches it", async () => {
		const d = deps({ render: vi.fn(async () => Promise.reject(new Error("font missing"))) });
		const out = await requestFactura(paidInvoice(), ORG, d);
		expect(out).toMatchObject({ ok: false, reason: "pdf_failed" });
		expect(d.store.rows[0].number).toBe("0000000001");
		expect(d.store.rows[0].pdfKey).toBeNull();

		const replay = await requestFactura(paidInvoice(), ORG, { ...d, render });
		expect(replay).toMatchObject({ ok: true, factura: { number: "0000000001" } });
		expect(d.store.rows[0].pdfKey).not.toBeNull();
		expect(d.store.last).toBe(1);
	});

	it("refuses a stored PDF whose hash does not match", async () => {
		const d = deps();
		await requestFactura(paidInvoice(), ORG, d);
		d.pdfStorage.objects.set(`${ORG}/in_test_1.pdf`, new TextEncoder().encode("tampered"));
		expect(await requestFactura(paidInvoice(), ORG, d)).toMatchObject({ ok: false, reason: "pdf_integrity" });
	});

	it("re-renders a PDF missing from storage when the render reproduces the recorded hash", async () => {
		const d = deps();
		await requestFactura(paidInvoice(), ORG, d);
		d.pdfStorage.objects.clear();
		expect(await requestFactura(paidInvoice(), ORG, d)).toMatchObject({ ok: true });
		expect(d.pdfStorage.objects.size).toBe(1);
	});

	it("says store_failed, and issues nothing, when the transaction fails", async () => {
		const d = deps();
		const out = await requestFactura(paidInvoice(), ORG, {
			...d,
			store: { ...d.store, issue: async () => Promise.reject(new Error("db down")) },
		});
		expect(out).toMatchObject({ ok: false, reason: "store_failed" });
	});

	it("shares one issue between concurrent callers for the same invoice", async () => {
		const d = deps();
		const [a, b] = await Promise.all([requestFactura(paidInvoice(), ORG, d), requestFactura(paidInvoice(), ORG, d)]);
		expect(a).toEqual(b);
		expect(d.store.last).toBe(1);
	});
});

describe("issuedFacturaFor (the receipt email)", () => {
	it("returns the issued фактура with its PDF, and null before one is issued", async () => {
		const d = deps();
		expect(await issuedFacturaFor("in_test_1", d)).toBeNull();
		await requestFactura(paidInvoice(), ORG, d);
		expect(await issuedFacturaFor("in_test_1", d)).toMatchObject({ number: "0000000001" });
		expect(d.store.last).toBe(1);
	});
});

describe("sofiaDay", () => {
	it("dates a payment in Sofia, not UTC", () => {
		expect(sofiaDay(new Date(Date.UTC(2027, 0, 15, 22, 30)))).toBe("2027-01-16");
		expect(sofiaDay(new Date(Date.UTC(2027, 0, 15, 21, 30)))).toBe("2027-01-15");
	});
});
