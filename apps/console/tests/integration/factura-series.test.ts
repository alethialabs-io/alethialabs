// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration (real Postgres): the фактура number series and the immutable фактура row (#7367).
// What a mocked db cannot show:
//
//   1. IMMUTABILITY — even the BYPASSRLS service role cannot UPDATE, DELETE or TRUNCATE an issued
//      factura row; the one write admitted is attaching the PDF once.
//   2. NO GAPS — a number taken in a transaction that rolls back is returned, so the next issue gets
//      it; a number taken without inserting its document cannot commit; the counter cannot go back
//      or jump; concurrent issuers get consecutive numbers.
//   3. RLS — the app role reads only its own org's rows and writes neither table.
//
// Each test takes numbers from its OWN series row, started at a random high base, never from `BG`:
// the rows it issues are immutable by design, so they are removed in teardown with the table's
// triggers off (session_replication_role = replica, which needs the superuser the suite migrates as).

import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { getServiceDb, withOwnerScope } from "@/lib/db";
import { factura, facturaSeries } from "@/lib/db/schema";
import type { FacturaSnapshot } from "@/types/jsonb.types";
import { APP_ROLE_DISTINCT, describeIfDb, errorText } from "./db";

type ServiceTx = Parameters<Parameters<ReturnType<typeof getServiceDb>["transaction"]>[0]>[0];

describeIfDb("factura series: gap-free counter and immutable фактура", () => {
	const ORG_A = randomUUID();
	const ORG_B = randomUUID();
	const SERIES = `T-${randomUUID()}`;
	// A random base in the top of the ten-digit range, so parallel runs and the real series do not
	// collide on the globally unique number.
	const BASE = 9_000_000_000 + Math.floor(Math.random() * 900_000_000);
	const issuedIds: string[] = [];

	/** The ten-digit, zero-padded form of `n`. */
	function pad(n: number): string {
		return String(n).padStart(10, "0");
	}

	/** A minimal snapshot for the row; the content is not under test here. */
	function snapshot(number: string): FacturaSnapshot {
		return {
			version: 1,
			documentName: "ФАКТУРА",
			number,
			issueDate: "2027-01-15",
			chargeableDate: "2027-01-15",
			supplier: { name: "Supplier", addressLines: ["Sofia"], country: "BG", identifiers: [] },
			recipient: { name: "Recipient", addressLines: ["Berlin"], country: "DE", identifiers: [] },
			lines: [],
			currency: "EUR",
			taxBaseMinor: 1000,
			vatMinor: 0,
			totalMinor: 1000,
			noVatGround: "чл. 113, ал. 9 ЗДДС",
			eurEquivalent: null,
			original: null,
			stripeInvoiceNumber: null,
		};
	}

	/** Takes the next number from the test series inside `tx`, the way the issuer does. */
	async function takeNumber(tx: ServiceTx): Promise<string> {
		const [row] = await tx
			.update(facturaSeries)
			.set({ lastNumber: sql`${facturaSeries.lastNumber} + 1` })
			.where(eq(facturaSeries.id, SERIES))
			.returning({ lastNumber: facturaSeries.lastNumber });
		return pad(row.lastNumber);
	}

	/** Takes a number and inserts its фактура in one transaction; returns the row id and number. */
	async function issue(orgId: string): Promise<{ id: string; number: string }> {
		const out = await getServiceDb().transaction(async (tx) => {
			const number = await takeNumber(tx);
			const [row] = await tx
				.insert(factura)
				.values({
					organizationId: orgId,
					number,
					kind: "invoice",
					stripeInvoiceId: `in_test_${randomUUID()}`,
					issueDate: "2027-01-15",
					chargeableDate: "2027-01-15",
					snapshot: snapshot(number),
				})
				.returning({ id: factura.id, number: factura.number });
			return row;
		});
		issuedIds.push(out.id);
		return out;
	}

	/** The test series' current counter value. */
	async function lastNumber(): Promise<number> {
		const [row] = await getServiceDb()
			.select({ n: facturaSeries.lastNumber })
			.from(facturaSeries)
			.where(eq(facturaSeries.id, SERIES));
		return row.n;
	}

	beforeAll(async () => {
		await getServiceDb().insert(facturaSeries).values({ id: SERIES, lastNumber: BASE });
	});

	afterAll(async () => {
		await getServiceDb().transaction(async (tx) => {
			await tx.execute(sql`set local session_replication_role = replica`);
			if (issuedIds.length) await tx.delete(factura).where(inArray(factura.id, issuedIds));
			await tx.delete(facturaSeries).where(eq(facturaSeries.id, SERIES));
		});
	});

	it("seeds the BG series", async () => {
		const [row] = await getServiceDb()
			.select({ id: facturaSeries.id })
			.from(facturaSeries)
			.where(eq(facturaSeries.id, "BG"));
		expect(row?.id).toBe("BG");
	});

	// ── 1. Immutability ──────────────────────────────────────────────────────────────────────────
	it("refuses an UPDATE of an issued фактура's legal fields, even from the service role", async () => {
		const doc = await issue(ORG_A);
		const err = await getServiceDb()
			.update(factura)
			.set({ issueDate: "2027-01-16" })
			.where(eq(factura.id, doc.id))
			.then(
				() => null,
				(e: unknown) => e,
			);
		expect(errorText(err)).toMatch(/factura is issued and immutable: UPDATE/);
	});

	it("refuses a DELETE of an issued фактура, even from the service role", async () => {
		const doc = await issue(ORG_A);
		const err = await getServiceDb()
			.delete(factura)
			.where(eq(factura.id, doc.id))
			.then(
				() => null,
				(e: unknown) => e,
			);
		expect(errorText(err)).toMatch(/factura is issued and immutable: DELETE/);
		const [still] = await getServiceDb().select({ id: factura.id }).from(factura).where(eq(factura.id, doc.id));
		expect(still?.id).toBe(doc.id);
	});

	it("refuses a TRUNCATE of the фактура table", async () => {
		await issue(ORG_A);
		const err = await getServiceDb()
			.execute(sql`truncate table public.factura`)
			.then(
				() => null,
				(e: unknown) => e,
			);
		expect(errorText(err)).toMatch(/factura is issued and immutable: TRUNCATE/);
	});

	it("admits attaching the PDF once, and refuses a second attach", async () => {
		const doc = await issue(ORG_A);
		const sha = "a".repeat(64);
		await getServiceDb()
			.update(factura)
			.set({ pdfKey: `${ORG_A}/${doc.number}.pdf`, pdfSha256: sha })
			.where(eq(factura.id, doc.id));
		const err = await getServiceDb()
			.update(factura)
			.set({ pdfKey: `${ORG_A}/other.pdf`, pdfSha256: "b".repeat(64) })
			.where(eq(factura.id, doc.id))
			.then(
				() => null,
				(e: unknown) => e,
			);
		expect(errorText(err)).toMatch(/factura is issued and immutable: UPDATE/);
		const [row] = await getServiceDb()
			.select({ sha: factura.pdfSha256 })
			.from(factura)
			.where(eq(factura.id, doc.id));
		expect(row.sha).toBe(sha);
	});

	it("refuses a PDF attach that also changes a legal field", async () => {
		const doc = await issue(ORG_A);
		const err = await getServiceDb()
			.update(factura)
			.set({ pdfKey: "k.pdf", pdfSha256: "c".repeat(64), stripeInvoiceId: "in_other" })
			.where(eq(factura.id, doc.id))
			.then(
				() => null,
				(e: unknown) => e,
			);
		expect(errorText(err)).toMatch(/factura is issued and immutable: UPDATE/);
	});

	// ── 2. No gaps ───────────────────────────────────────────────────────────────────────────────
	it("returns the number of a rolled-back issue, so the next issue gets it", async () => {
		const before = await lastNumber();
		class Abort extends Error {}
		let takenInside = "";
		await expect(
			getServiceDb().transaction(async (tx) => {
				takenInside = await takeNumber(tx);
				await tx.insert(factura).values({
					organizationId: ORG_A,
					number: takenInside,
					kind: "invoice",
					stripeInvoiceId: `in_test_${randomUUID()}`,
					issueDate: "2027-01-15",
					chargeableDate: "2027-01-15",
					snapshot: snapshot(takenInside),
				});
				throw new Abort("render failed");
			}),
		).rejects.toBeInstanceOf(Abort);
		expect(takenInside).toBe(pad(before + 1));
		expect(await lastNumber()).toBe(before);

		const next = await issue(ORG_A);
		expect(next.number).toBe(pad(before + 1));
	});

	it("refuses to commit a number taken without its фактура", async () => {
		const before = await lastNumber();
		const err = await getServiceDb()
			.transaction(async (tx) => {
				await takeNumber(tx);
			})
			.then(
				() => null,
				(e: unknown) => e,
			);
		expect(errorText(err)).toMatch(/was taken but no factura was issued with it/);
		expect(await lastNumber()).toBe(before);
	});

	it("refuses to move the counter back or skip ahead", async () => {
		const before = await lastNumber();
		for (const to of [before - 1, before + 2]) {
			const err = await getServiceDb()
				.update(facturaSeries)
				.set({ lastNumber: to })
				.where(eq(facturaSeries.id, SERIES))
				.then(
					() => null,
					(e: unknown) => e,
				);
			expect(errorText(err)).toMatch(/factura_series moves forward by one only: UPDATE/);
		}
		const delErr = await getServiceDb()
			.delete(facturaSeries)
			.where(eq(facturaSeries.id, SERIES))
			.then(
				() => null,
				(e: unknown) => e,
			);
		expect(errorText(delErr)).toMatch(/factura_series moves forward by one only: DELETE/);
		expect(await lastNumber()).toBe(before);
	});

	it("gives concurrent issuers consecutive numbers", async () => {
		const before = await lastNumber();
		const docs = await Promise.all(Array.from({ length: 5 }, () => issue(ORG_B)));
		const numbers = docs.map((d) => d.number).sort();
		expect(numbers).toEqual(Array.from({ length: 5 }, (_, i) => pad(before + 1 + i)));
	});

	// ── 3. RLS ───────────────────────────────────────────────────────────────────────────────────
	it.skipIf(!APP_ROLE_DISTINCT)("the app role reads only its own org's фактури", async () => {
		const mine = await issue(ORG_A);
		const theirs = await issue(ORG_B);
		const rows = await withOwnerScope(ORG_A, (tx) =>
			tx
				.select({ id: factura.id, org: factura.organizationId })
				.from(factura)
				.where(inArray(factura.id, [mine.id, theirs.id])),
		);
		expect(rows.map((r) => r.id)).toEqual([mine.id]);
	});

	it.skipIf(!APP_ROLE_DISTINCT)("the app role cannot issue a фактура or take a number", async () => {
		const number = pad(BASE - 1);
		await expect(
			withOwnerScope(ORG_A, (tx) =>
				tx.insert(factura).values({
					organizationId: ORG_A,
					number,
					kind: "invoice",
					stripeInvoiceId: `in_test_${randomUUID()}`,
					issueDate: "2027-01-15",
					chargeableDate: "2027-01-15",
					snapshot: snapshot(number),
				}),
			),
		).rejects.toThrow();
		await expect(
			withOwnerScope(ORG_A, (tx) =>
				tx
					.update(facturaSeries)
					.set({ lastNumber: sql`${facturaSeries.lastNumber} + 1` })
					.where(eq(facturaSeries.id, SERIES)),
			),
		).rejects.toThrow();
	});
});
