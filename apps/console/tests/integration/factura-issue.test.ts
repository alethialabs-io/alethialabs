// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration (real Postgres): the console's фактура issuer under concurrency (#7368).
//
//   1. Concurrent issues for DIFFERENT paid invoices get consecutive ten-digit numbers from the BG
//      series, with no gap and no repeat.
//   2. Concurrent issues for the SAME invoice produce one фактура and advance the counter by one: the
//      loser's insert hits the (stripe_invoice_id, kind) key, its transaction rolls back, and its
//      number goes back to the series.
//
// It goes through `dbFacturaStore` and `requestFactura`, the production path, with the PDF renderer
// and object storage replaced (neither is under test here). The rows it issues are immutable by
// design, so teardown removes them and puts the BG counter back with the table's triggers off
// (session_replication_role = replica, the superuser the suite migrates as).

import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { dbFacturaStore, requestFactura } from "@/lib/billing/factura/issue";
import { getServiceDb } from "@/lib/db";
import { FACTURA_SERIES_BG, factura, facturaSeries } from "@/lib/db/schema";
import { describeIfDb } from "./db";

describeIfDb("фактура issuer: gap-free numbers under concurrency", () => {
	const ORG = randomUUID();
	const RUN = randomUUID().slice(0, 8);
	let startNumber = 0;

	/** The BG counter now. */
	async function counter(): Promise<number> {
		const [row] = await getServiceDb()
			.select({ n: facturaSeries.lastNumber })
			.from(facturaSeries)
			.where(eq(facturaSeries.id, FACTURA_SERIES_BG));
		return row.n;
	}

	/** A paid EUR invoice with every recipient detail, id `in_<RUN>_<suffix>`. */
	function invoice(suffix: string) {
		return {
			id: `in_${RUN}_${suffix}`,
			number: null,
			currency: "eur",
			customer_name: "Acme GmbH",
			customer_address: { line1: "Hauptstraße 1", line2: null, city: "Berlin", postal_code: "10115", state: null, country: "DE" },
			customer_tax_ids: [{ type: "eu_vat" as const, value: "DE123456789" }],
			total: 1000,
			total_excluding_tax: 1000,
			status_transitions: { paid_at: 1_800_000_000, finalized_at: null, marked_uncollectible_at: null, voided_at: null },
			lines: { data: [{ description: "Alethia Pro", amount: 1000, quantity: 1, period: null }] },
		};
	}

	const deps = {
		render: async () => new TextEncoder().encode("%PDF-test"),
		pdfStorage: { put: async () => undefined, get: async () => null },
	};

	beforeAll(async () => {
		startNumber = await counter();
	});

	afterAll(async () => {
		await getServiceDb().transaction(async (tx) => {
			await tx.execute(sql`set local session_replication_role = replica`);
			await tx.delete(factura).where(eq(factura.organizationId, ORG));
			await tx.update(facturaSeries).set({ lastNumber: startNumber }).where(eq(facturaSeries.id, FACTURA_SERIES_BG));
		});
	});

	it("gives concurrent issues for different invoices consecutive numbers", async () => {
		const outcomes = await Promise.all(
			Array.from({ length: 6 }, (_, i) => requestFactura(invoice(`d${i}`), ORG, deps)),
		);
		const numbers = outcomes.map((o) => (o.ok ? o.factura.number : `failed:${o.reason}`)).sort();
		expect(numbers).toEqual(Array.from({ length: 6 }, (_, i) => String(startNumber + 1 + i).padStart(10, "0")));
		expect(await counter()).toBe(startNumber + 6);
	});

	it("issues one фактура for concurrent issues of the same invoice, and spends one number", async () => {
		const before = await counter();
		const inv = invoice("same");
		// Straight at the store, past requestFactura's in-process dedupe, so the database decides.
		const build = (number: string) => ({
			organizationId: ORG,
			number,
			kind: "invoice" as const,
			stripeInvoiceId: inv.id,
			issueDate: "2027-01-16",
			chargeableDate: "2027-01-15",
			snapshot: {
				version: 1 as const,
				documentName: "ФАКТУРА",
				number,
				issueDate: "2027-01-16",
				chargeableDate: "2027-01-15",
				supplier: { name: "S", addressLines: [], country: "BG", identifiers: [] },
				recipient: { name: "R", addressLines: [], country: "DE", identifiers: [] },
				lines: [],
				currency: "EUR",
				taxBaseMinor: 1000,
				vatMinor: 0,
				totalMinor: 1000,
				noVatGround: "чл. 113, ал. 9 ЗДДС",
				eurEquivalent: null,
				original: null,
				stripeInvoiceNumber: null,
			},
		});
		const results = await Promise.all(Array.from({ length: 4 }, () => dbFacturaStore.issue(build)));
		expect(results.filter((r) => r !== null)).toHaveLength(1);
		expect(await counter()).toBe(before + 1);
		const rows = await getServiceDb()
			.select({ number: factura.number })
			.from(factura)
			.where(inArray(factura.stripeInvoiceId, [inv.id]));
		expect(rows).toEqual([{ number: String(before + 1).padStart(10, "0") }]);
	});
});
