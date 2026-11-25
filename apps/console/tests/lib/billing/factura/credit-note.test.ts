// @vitest-environment node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #7369: the credit note (кредитно известие) for a Stripe refund. The golden half prints a full and
// a partial credit note of the USD фактура and compares every string against golden/credit-note-*.txt;
// the issuer half runs `requestCreditNote` against an in-memory store: one credit note per refund,
// from the same series as the фактура, naming it; a replay or a second delivery issues nothing new;
// a second partial refund gets its own; nothing is issued without a фактура, in another currency,
// or past the фактура's total.

import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));
vi.mock("@/lib/storage", () => ({ storage: { put: vi.fn(), get: vi.fn() } }));
vi.mock("@/lib/billing/operator-alert", () => ({ alertOperator: vi.fn(async () => true) }));

import { buildCreditNoteSnapshot } from "@/lib/billing/factura/credit-note-snapshot";
import {
	type CreditNoteDeps,
	type CreditNoteStore,
	issueCreditNotesForCharge,
	type RefundReader,
	type RefundSource,
	requestCreditNote,
} from "@/lib/billing/factura/credit-note";
import { renderFacturaPdf } from "@/lib/billing/factura/document";
import type { FacturaPdfStorage } from "@/lib/billing/factura/issue";
import { facturaLayout, layoutText } from "@/lib/billing/factura/layout";
import { buildFacturaSnapshot } from "@/lib/billing/factura/snapshot";
import { alertOperator } from "@/lib/billing/operator-alert";
import type { Factura, FacturaInsert } from "@/lib/db/schema";
import type { FacturaSnapshot } from "@/types/jsonb.types";
import { USD_RATE, paidInvoice } from "./fixtures";

/** фактура 0000000001 for the fixture invoice in `currency`. */
function originalSnapshot(currency: "eur" | "usd"): FacturaSnapshot {
	return buildFacturaSnapshot(paidInvoice({ currency }), {
		number: "0000000001",
		issueDate: "2027-01-16",
		chargeableDate: "2027-01-15",
		noVatGround: "чл. 113, ал. 9 ЗДДС",
		eurRate: currency === "usd" ? USD_RATE : null,
	});
}

/** 2027-01-20 10:00 UTC, the refund. */
const REFUNDED_AT = Date.UTC(2027, 0, 20, 10, 0, 0) / 1000;

/** A succeeded refund of `amount` minor units; `over` replaces fields. */
function refund(over: Partial<RefundSource> = {}): RefundSource {
	return { id: "re_1", amount: 5500, currency: "usd", created: REFUNDED_AT, status: "succeeded", ...over };
}

/** A row as the database would hold it. */
function rowOf(id: string, insert: FacturaInsert): Factura {
	return {
		id,
		organizationId: insert.organizationId ?? null,
		source: insert.source ?? "stripe",
		manualKey: insert.manualKey ?? null,
		number: insert.number,
		kind: insert.kind,
		originalFacturaId: insert.originalFacturaId ?? null,
		stripeInvoiceId: insert.stripeInvoiceId ?? null,
		stripeRefundId: insert.stripeRefundId ?? null,
		issueDate: insert.issueDate,
		chargeableDate: insert.chargeableDate,
		snapshot: insert.snapshot,
		pdfKey: null,
		pdfSha256: null,
		createdAt: new Date(),
	};
}

/** An in-memory store holding the issued USD фактура 0000000001 (or none), with a gap-free counter. */
function memoryStore(withOriginal = true, currency: "eur" | "usd" = "usd"): CreditNoteStore & { rows: Factura[]; last: number } {
	const rows: Factura[] = [];
	const store = {
		rows,
		last: 0,
		async findIssued(id: string) {
			return rows.find((r) => r.stripeInvoiceId === id && r.kind === "invoice") ?? null;
		},
		async findCreditNote(refundId: string) {
			return rows.find((r) => r.stripeRefundId === refundId && r.kind === "credit_note") ?? null;
		},
		async creditedMinor(originalId: string) {
			return rows
				.filter((r) => r.originalFacturaId === originalId)
				.reduce((sum, r) => sum - r.snapshot.totalMinor, 0);
		},
		async issue(build: (n: string) => FacturaInsert) {
			const next = store.last + 1;
			const insert = build(String(next).padStart(10, "0"));
			const clash = rows.some(
				(r) =>
					r.stripeInvoiceId === insert.stripeInvoiceId &&
					r.kind === insert.kind &&
					r.stripeRefundId === (insert.stripeRefundId ?? null),
			);
			if (clash) return null;
			store.last = next;
			const row = rowOf(`f${next}`, insert);
			rows.push(row);
			return row;
		},
		async attachPdf(id: string, key: string, sha: string) {
			const row = rows.find((r) => r.id === id);
			if (row && !row.pdfKey) Object.assign(row, { pdfKey: key, pdfSha256: sha });
		},
	};
	if (withOriginal) {
		store.last = 1;
		rows.push(
			rowOf("f1", {
				organizationId: "org_1",
				number: "0000000001",
				kind: "invoice",
				stripeInvoiceId: "in_test_1",
				issueDate: "2027-01-16",
				chargeableDate: "2027-01-15",
				snapshot: originalSnapshot(currency),
			}),
		);
	}
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

/** Test dependencies around `store`, with a renderer whose bytes name the document number. */
function deps(store: CreditNoteStore, pdfStorage = memoryStorage()): CreditNoteDeps {
	return {
		store,
		pdfStorage,
		render: async (s) => new TextEncoder().encode(`%PDF-${s.number}`),
		now: () => new Date(Date.UTC(2027, 0, 21, 8, 0, 0)),
	};
}

describe("credit note golden render", () => {
	it("prints the full USD credit note exactly as golden/credit-note-usd-full.txt", async () => {
		const s = buildCreditNoteSnapshot(originalSnapshot("usd"), 5500, {
			number: "0000000002",
			issueDate: "2027-01-21",
			chargeableDate: "2027-01-20",
		});
		const text = layoutText(facturaLayout(s));
		await expect(`${text}\n`).toMatchFileSnapshot("./golden/credit-note-usd-full.txt");
		expect(text).toContain("КРЕДИТНО ИЗВЕСТИЕ / Credit note");
		expect(text).toContain("Към фактура / Corrects invoice: № 0000000001 от 16.01.2027");
		// A full refund nets the EUR equivalent to exactly zero against the фактура's €50.60.
		expect(s.eurEquivalent?.taxBaseEurMinor).toBe(-5060);
	});

	it("prints the partial EUR credit note exactly as golden/credit-note-eur-partial.txt", async () => {
		const s = buildCreditNoteSnapshot(originalSnapshot("eur"), 2000, {
			number: "0000000003",
			issueDate: "2027-01-21",
			chargeableDate: "2027-01-20",
		});
		const text = layoutText(facturaLayout(s));
		await expect(`${text}\n`).toMatchFileSnapshot("./golden/credit-note-eur-partial.txt");
		expect(s.totalMinor).toBe(-2000);
		expect(s.lines).toHaveLength(1);
		expect(s.eurEquivalent).toBeNull();
	});

	it("renders the credit note to a PDF, the same bytes every time", async () => {
		const s = buildCreditNoteSnapshot(originalSnapshot("usd"), 5500, {
			number: "0000000002",
			issueDate: "2027-01-21",
			chargeableDate: "2027-01-20",
		});
		const a = await renderFacturaPdf(s);
		const b = await renderFacturaPdf(s);
		expect(new TextDecoder().decode(a.subarray(0, 5))).toBe("%PDF-");
		expect(createHash("sha256").update(a).digest("hex")).toBe(createHash("sha256").update(b).digest("hex"));
	}, 30_000);

	it("converts a partial USD refund at the фактура's rate", () => {
		const s = buildCreditNoteSnapshot(originalSnapshot("usd"), 1000, {
			number: "0000000002",
			issueDate: "2027-01-21",
			chargeableDate: "2027-01-20",
		});
		expect(s.eurEquivalent).toMatchObject({ taxBaseEurMinor: -920, rate: "0.92000000", source: "ECB:2027-01-14" });
	});
});

describe("requestCreditNote", () => {
	it("issues the next number in the series, naming the фактура, with its PDF keyed by refund", async () => {
		const store = memoryStore();
		const storage = memoryStorage();
		const outcome = await requestCreditNote("in_test_1", refund(), deps(store, storage));
		expect(outcome).toMatchObject({ ok: true, creditNote: { number: "0000000002" } });
		const row = store.rows[1];
		expect(row).toMatchObject({
			kind: "credit_note",
			originalFacturaId: "f1",
			stripeRefundId: "re_1",
			chargeableDate: "2027-01-20",
			issueDate: "2027-01-21",
		});
		expect(row?.snapshot.original).toEqual({ number: "0000000001", issueDate: "2027-01-16" });
		expect(row?.pdfKey).toBe("org_1/in_test_1.credit-re_1.pdf");
		expect(storage.objects.has("org_1/in_test_1.credit-re_1.pdf")).toBe(true);
	});

	it("a replay of the same refund issues nothing new and returns the same credit note", async () => {
		const store = memoryStore();
		const d = deps(store);
		await requestCreditNote("in_test_1", refund(), d);
		const again = await requestCreditNote("in_test_1", refund(), d);
		expect(again).toMatchObject({ ok: true, creditNote: { number: "0000000002" } });
		expect(store.rows).toHaveLength(2);
		expect(store.last).toBe(2);
	});

	it("two partial refunds get two credit notes, and a third past the total is refused", async () => {
		const store = memoryStore();
		const d = deps(store);
		expect(await requestCreditNote("in_test_1", refund({ id: "re_a", amount: 2000 }), d)).toMatchObject({ ok: true });
		expect(await requestCreditNote("in_test_1", refund({ id: "re_b", amount: 3500 }), d)).toMatchObject({ ok: true });
		const over = await requestCreditNote("in_test_1", refund({ id: "re_c", amount: 1 }), d);
		expect(over).toMatchObject({ ok: false, reason: "over_credit" });
		expect(store.rows.map((r) => r.number)).toEqual(["0000000001", "0000000002", "0000000003"]);
		expect(store.last).toBe(3);
	});

	it("takes no number when no фактура was issued for the invoice", async () => {
		const store = memoryStore(false);
		const outcome = await requestCreditNote("in_test_1", refund(), deps(store));
		expect(outcome).toMatchObject({ ok: false, reason: "no_original" });
		expect(store.last).toBe(0);
	});

	it("takes no number for a refund in another currency, or one that has not succeeded", async () => {
		const store = memoryStore();
		expect(await requestCreditNote("in_test_1", refund({ currency: "eur" }), deps(store))).toMatchObject({
			ok: false,
			reason: "currency_mismatch",
		});
		expect(await requestCreditNote("in_test_1", refund({ status: "pending" }), deps(store))).toMatchObject({
			ok: false,
			reason: "refund_not_succeeded",
		});
		expect(store.last).toBe(1);
	});

	it("a PDF failure leaves the credit note issued, and a replay attaches the PDF", async () => {
		const store = memoryStore();
		const broken = { ...deps(store), render: async () => Promise.reject(new Error("font")) };
		expect(await requestCreditNote("in_test_1", refund(), broken)).toMatchObject({ ok: false, reason: "pdf_failed" });
		expect(store.rows[1]?.pdfKey).toBeNull();
		expect(await requestCreditNote("in_test_1", refund(), deps(store))).toMatchObject({ ok: true });
		expect(store.rows[1]?.pdfKey).toBe("org_1/in_test_1.credit-re_1.pdf");
		expect(store.last).toBe(2);
	});
});

describe("issueCreditNotesForCharge", () => {
	/** A Stripe double: the charge's PaymentIntent paid in_test_1, and the charge has `refunds`. */
	function stripeWith(refunds: RefundSource[]): RefundReader {
		return {
			invoicePayments: { list: async () => ({ data: [{ invoice: "in_test_1" }] }) },
			refunds: { list: async () => ({ data: refunds }) },
		};
	}

	it("issues one credit note per succeeded refund, oldest first, and skips pending ones", async () => {
		const store = memoryStore();
		const outcomes = await issueCreditNotesForCharge(
			{ id: "ch_1", payment_intent: "pi_1" },
			stripeWith([
				refund({ id: "re_late", amount: 1000, created: REFUNDED_AT + 60 }),
				refund({ id: "re_early", amount: 2000 }),
				refund({ id: "re_pending", amount: 500, status: "pending" }),
			]),
			deps(store),
		);
		expect(outcomes).toHaveLength(2);
		expect(store.rows.slice(1).map((r) => [r.number, r.stripeRefundId])).toEqual([
			["0000000002", "re_early"],
			["0000000003", "re_late"],
		]);
	});

	it("alerts the operator for a refund with no фактура, without failing the event", async () => {
		vi.mocked(alertOperator).mockClear();
		const outcomes = await issueCreditNotesForCharge({ id: "ch_1", payment_intent: "pi_1" }, stripeWith([refund()]), deps(memoryStore(false)));
		expect(outcomes).toMatchObject([{ ok: false, reason: "no_original" }]);
		expect(alertOperator).toHaveBeenCalledTimes(1);
	});

	it("throws on a store failure so Stripe redelivers the event", async () => {
		const store = memoryStore();
		store.issue = async () => Promise.reject(new Error("db down"));
		await expect(
			issueCreditNotesForCharge({ id: "ch_1", payment_intent: "pi_1" }, stripeWith([refund()]), deps(store)),
		).rejects.toThrow("store_failed");
	});
});
