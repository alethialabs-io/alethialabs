// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration (real Postgres): credit notes in the фактура series (#7369).
//
//   1. Two partial refunds of one invoice get two credit notes, the numbers after the фактура's, each
//      naming the фактура (original_factura_id) and its own refund.
//   2. Concurrent requests for the SAME refund produce one credit note and spend one number: the
//      losers hit the (stripe_invoice_id, kind, stripe_refund_id) key, NULLS NOT DISTINCT, and roll
//      back.
//   3. The фактура itself is still one per invoice under that key (its refund id is NULL).
//
// Production path (`requestFactura`, `requestCreditNote`, the db stores), renderer and storage
// replaced. Teardown removes the immutable rows with triggers off and restores the counter.

import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

vi.mock("@/lib/billing/operator-alert", () => ({ alertOperator: vi.fn(async () => true) }));

import { dbCreditNoteStore, requestCreditNote } from "@/lib/billing/factura/credit-note";
import { requestFactura } from "@/lib/billing/factura/issue";
import { getServiceDb } from "@/lib/db";
import { FACTURA_SERIES_BG, factura, facturaSeries } from "@/lib/db/schema";
import { describeIfDb } from "./db";

describeIfDb("credit notes: one per refund, in the фактура series", () => {
	const ORG = randomUUID();
	const RUN = randomUUID().slice(0, 8);
	const INVOICE = `in_${RUN}_cn`;
	let startNumber = 0;

	/** The BG counter now. */
	async function counter(): Promise<number> {
		const [row] = await getServiceDb()
			.select({ n: facturaSeries.lastNumber })
			.from(facturaSeries)
			.where(eq(facturaSeries.id, FACTURA_SERIES_BG));
		return row.n;
	}

	const pdf = {
		render: async () => new TextEncoder().encode("%PDF-test"),
		pdfStorage: { put: async () => undefined, get: async () => null },
	};
	const deps = { ...pdf, store: dbCreditNoteStore, now: () => new Date(Date.UTC(2027, 0, 21)) };

	/** A succeeded EUR refund of `amount` cents with id `re_<RUN>_<suffix>`. */
	function refund(suffix: string, amount: number) {
		return { id: `re_${RUN}_${suffix}`, amount, currency: "eur", created: 1_800_100_000, status: "succeeded" as const };
	}

	beforeAll(async () => {
		startNumber = await counter();
		const issued = await requestFactura(
			{
				id: INVOICE,
				number: null,
				currency: "eur",
				customer_name: "Acme GmbH",
				customer_address: { line1: "Hauptstraße 1", line2: null, city: "Berlin", postal_code: "10115", state: null, country: "DE" },
				customer_tax_ids: [{ type: "eu_vat", value: "DE123456789" }],
				total: 1000,
				total_excluding_tax: 1000,
				status_transitions: { paid_at: 1_800_000_000, finalized_at: null, marked_uncollectible_at: null, voided_at: null },
				lines: { data: [{ description: "Alethia Pro", amount: 1000, quantity: 1, period: null }] },
			},
			ORG,
			pdf,
		);
		// A setup failure, not an assertion: every test below credits this фактура.
		if (!issued.ok) {
			throw new Error("setup: the original фактура was not issued");
		}
	});

	afterAll(async () => {
		await getServiceDb().transaction(async (tx) => {
			await tx.execute(sql`set local session_replication_role = replica`);
			await tx.delete(factura).where(eq(factura.organizationId, ORG));
			await tx.update(facturaSeries).set({ lastNumber: startNumber }).where(eq(facturaSeries.id, FACTURA_SERIES_BG));
		});
	});

	it("issues a credit note per partial refund, after the фактура, naming it", async () => {
		expect(await requestCreditNote(INVOICE, refund("a", 300), deps)).toMatchObject({ ok: true });
		expect(await requestCreditNote(INVOICE, refund("b", 200), deps)).toMatchObject({ ok: true });
		const rows = await getServiceDb()
			.select()
			.from(factura)
			.where(eq(factura.stripeInvoiceId, INVOICE))
			.orderBy(asc(factura.number));
		expect(rows.map((r) => [r.kind, r.number, r.stripeRefundId])).toEqual([
			["invoice", String(startNumber + 1).padStart(10, "0"), null],
			["credit_note", String(startNumber + 2).padStart(10, "0"), `re_${RUN}_a`],
			["credit_note", String(startNumber + 3).padStart(10, "0"), `re_${RUN}_b`],
		]);
		expect(rows[1]?.originalFacturaId).toBe(rows[0]?.id);
		expect(rows[1]?.snapshot.totalMinor).toBe(-300);
		expect(await dbCreditNoteStore.creditedMinor(rows[0]?.id ?? "")).toBe(500);
	});

	it("issues one credit note for concurrent requests of the same refund, spending one number", async () => {
		const before = await counter();
		const outcomes = await Promise.all(Array.from({ length: 4 }, () => requestCreditNote(INVOICE, refund("c", 100), deps)));
		expect(outcomes.every((o) => o.ok)).toBe(true);
		expect(new Set(outcomes.map((o) => (o.ok ? o.creditNote.number : "")))).toEqual(
			new Set([String(before + 1).padStart(10, "0")]),
		);
		expect(await counter()).toBe(before + 1);
		const rows = await getServiceDb()
			.select({ id: factura.id })
			.from(factura)
			.where(and(eq(factura.stripeRefundId, `re_${RUN}_c`), eq(factura.kind, "credit_note")));
		expect(rows).toHaveLength(1);
	});

	it("refuses a refund that would credit beyond the фактура, taking no number", async () => {
		const before = await counter();
		expect(await requestCreditNote(INVOICE, refund("d", 401), deps)).toMatchObject({ ok: false, reason: "over_credit" });
		expect(await counter()).toBe(before);
	});
});
