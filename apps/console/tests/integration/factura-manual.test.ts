// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration (real Postgres): the `manual` source of the фактура series (L6b).
//
//   1. Concurrent issues under the SAME operator key produce one document and advance the counter by
//      one: the losers hit `factura_manual_key`, their transactions roll back and return the number.
//   2. Manual and Stripe documents draw consecutive numbers from the one BG counter.
//   3. The `factura_source_link` CHECK: a manual row without its key, or a Stripe row without its
//      organization, cannot be inserted.
//
// Rows are tagged with this run's organization id so teardown can remove them (with the triggers off,
// as factura-issue.test.ts does) and put the counter back.

import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { dbFacturaStore, issueInSeries } from "@/lib/billing/factura/issue";
import { getServiceDb } from "@/lib/db";
import { FACTURA_SERIES_BG, type FacturaInsert, factura, facturaSeries } from "@/lib/db/schema";
import type { FacturaSnapshot } from "@/types/jsonb.types";
import { describeIfDb } from "./db";

describeIfDb("фактура series: the manual source", () => {
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

	/** A minimal snapshot with `number`. */
	function snapshot(number: string): FacturaSnapshot {
		return {
			version: 1,
			documentName: "ФАКТУРА",
			number,
			issueDate: "2027-01-02",
			chargeableDate: "2026-12-31",
			supplier: { name: "S", addressLines: [], country: "BG", identifiers: [] },
			recipient: { name: "Paddle.com Market Ltd", addressLines: [], country: "GB", identifiers: [] },
			lines: [],
			currency: "EUR",
			taxBaseMinor: 1000,
			vatMinor: 0,
			totalMinor: 1000,
			noVatGround: "чл. 21, ал. 2 ЗДДС",
			eurEquivalent: null,
			original: null,
			stripeInvoiceNumber: null,
			source: "manual",
		};
	}

	/** A manual фактура under `key`. Tagged with ORG so teardown finds it. */
	const manual = (key: string) => (number: string): FacturaInsert => ({
		organizationId: ORG,
		source: "manual",
		manualKey: key,
		number,
		kind: "invoice",
		issueDate: "2027-01-02",
		chargeableDate: "2026-12-31",
		snapshot: snapshot(number),
	});

	/** A Stripe фактура for invoice `id`. */
	const stripe = (id: string) => (number: string): FacturaInsert => ({
		organizationId: ORG,
		number,
		kind: "invoice",
		stripeInvoiceId: id,
		issueDate: "2027-01-02",
		chargeableDate: "2026-12-31",
		snapshot: snapshot(number),
	});

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

	it("issues one document for concurrent issues under the same key, and spends one number", async () => {
		const before = await counter();
		const key = `paddle-market:${RUN}`;
		const results = await Promise.all(Array.from({ length: 4 }, () => issueInSeries(manual(key), "manual")));
		expect(results.filter((r) => r !== null)).toHaveLength(1);
		expect(await counter()).toBe(before + 1);
		const rows = await getServiceDb().select({ number: factura.number }).from(factura).where(eq(factura.manualKey, key));
		expect(rows).toEqual([{ number: String(before + 1).padStart(10, "0") }]);
	});

	it("interleaves manual and Stripe documents in one gap-free series", async () => {
		const before = await counter();
		const a = await dbFacturaStore.issue(stripe(`in_${RUN}_a`));
		const b = await issueInSeries(manual(`ent:${RUN}:b`), "manual");
		const c = await dbFacturaStore.issue(stripe(`in_${RUN}_c`));
		expect([a?.number, b?.number, c?.number]).toEqual(
			[1, 2, 3].map((i) => String(before + i).padStart(10, "0")),
		);
		expect([a?.source, b?.source, c?.source]).toEqual(["stripe", "manual", "stripe"]);
	});

	it("refuses a manual row without its key and a Stripe row without its organization", async () => {
		const before = await counter();
		await expect(
			issueInSeries((n) => ({ ...manual("unused")(n), manualKey: null }), "manual"),
		).rejects.toThrow();
		await expect(
			issueInSeries((n) => ({ ...stripe(`in_${RUN}_noorg`)(n), organizationId: null }), "stripe"),
		).rejects.toThrow();
		await expect(
			issueInSeries((n) => ({ ...manual(`k:${RUN}:x`)(n), stripeInvoiceId: `in_${RUN}_x` }), "manual"),
		).rejects.toThrow();
		expect(await counter()).toBe(before);
	});
});
