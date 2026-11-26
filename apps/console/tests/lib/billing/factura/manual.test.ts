// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// L6b: the `manual` source of the фактура pipeline. The monthly фактура to Paddle.com Market Ltd
// (outside scope, Art. 21(2)), an Enterprise contract at the domestic 20% and under the EU reverse
// charge, the input validation, the idempotent re-run, the numbering it shares with the Stripe path,
// and the manual credit note. The database is an in-memory store with one counter for both sources;
// tests/integration/factura-manual.test.ts runs the real one.

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));
vi.mock("@/lib/storage", () => ({ storage: { put: vi.fn(), get: vi.fn() } }));

import { requestFactura, type FacturaStore } from "@/lib/billing/factura/issue";
import { facturaLayout, layoutText } from "@/lib/billing/factura/layout";
import {
	issueManualCreditNote,
	issueManualFactura,
	type ManualCreditNoteInput,
	type ManualDeps,
	type ManualFacturaInput,
	type ManualFacturaStore,
	manualCreditNoteInputSchema,
	manualFacturaInputSchema,
	PROPOSED_NUMBER,
	proposeManualCreditNote,
	proposeManualFactura,
	toMinor,
} from "@/lib/billing/factura/manual";
import { GROUND_EU_REVERSE_CHARGE, GROUND_OUTSIDE_SCOPE } from "@/lib/billing/factura/vat-treatment";
import type { Factura, FacturaInsert } from "@/lib/db/schema";
import { paidInvoice, USD_RATE } from "./fixtures";

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

/** One table and one gap-free counter, seen through the Stripe store and the manual store. */
function memoryDb() {
	const db = { rows: [] as Factura[], last: 0 };
	/** Takes the next number, inserts unless `clash` finds an existing row (then returns the number). */
	const issue = (build: (n: string) => FacturaInsert, clash: (i: FacturaInsert) => boolean): Factura | null => {
		const insert = build(String(db.last + 1).padStart(10, "0"));
		if (clash(insert)) return null;
		db.last++;
		const row = rowOf(`f${db.last}`, insert);
		db.rows.push(row);
		return row;
	};
	const attachPdf = async (id: string, key: string, sha: string) => {
		const row = db.rows.find((r) => r.id === id);
		if (row && !row.pdfKey) Object.assign(row, { pdfKey: key, pdfSha256: sha });
	};
	const stripe: FacturaStore = {
		async findIssued(id) {
			return db.rows.find((r) => r.stripeInvoiceId === id && r.kind === "invoice") ?? null;
		},
		async issue(build) {
			return issue(build, (i) => db.rows.some((r) => r.stripeInvoiceId === i.stripeInvoiceId && r.kind === i.kind));
		},
		attachPdf,
	};
	const manual: ManualFacturaStore & { raceOnce?: () => void } = {
		async findByManualKey(key) {
			return db.rows.find((r) => r.manualKey === key) ?? null;
		},
		async findByNumber(number) {
			return db.rows.find((r) => r.number === number) ?? null;
		},
		async issue(build) {
			manual.raceOnce?.();
			manual.raceOnce = undefined;
			return issue(build, (i) => db.rows.some((r) => r.manualKey === i.manualKey));
		},
		attachPdf,
		async creditedBaseMinor(id) {
			return db.rows
				.filter((r) => r.originalFacturaId === id && r.kind === "credit_note")
				.reduce((sum, r) => sum - r.snapshot.taxBaseMinor, 0);
		},
	};
	return { db, stripe, manual };
}

/** The registered supplier the Paddle фактура is issued by. */
const REGISTERED = { vatRegistered: true, vatNumber: "BG208913663" };

/** Manual dependencies over `store`: memory storage, a fixed rate, the clock at 2027-01-02 in Sofia. */
function deps(store: ManualFacturaStore, over: Partial<ManualDeps> = {}): ManualDeps {
	const objects = new Map<string, Uint8Array>();
	return {
		store,
		pdfStorage: {
			async put(_b, key, body) {
				objects.set(key, body);
			},
			async get(_b, key) {
				return objects.get(key) ?? null;
			},
		},
		rateLookup: vi.fn(async () => USD_RATE),
		render: async (s) => new TextEncoder().encode(`%PDF ${s.number} ${s.totalMinor}`),
		supplier: REGISTERED,
		now: () => new Date(Date.UTC(2027, 0, 2, 10, 0, 0)),
		...over,
	};
}

/** The monthly фактура to Paddle.com Market Ltd for December 2026. */
function paddleInput(over: Partial<ManualFacturaInput> = {}): ManualFacturaInput {
	return manualFacturaInputSchema.parse({
		key: "paddle-market:2026-12",
		recipient: {
			name: "Paddle.com Market Ltd",
			addressLine1: "Judd House, 18-29 Mora Street",
			city: "London",
			postalCode: "EC1V 8BT",
			country: "gb",
			vatNumber: "GB 123 4567 89",
		},
		chargeableDate: "2026-12-31",
		lines: [
			{
				description: "Software services supplied via Paddle, December 2026 (net supplier proceeds)",
				unitAmount: "1234.56",
				periodStart: "2026-12-01",
				periodEnd: "2026-12-31",
			},
		],
		reference: "Paddle payout reconciliation 2026-12",
		...over,
	});
}

/** An Enterprise contract фактура to a buyer in `country`. */
function enterpriseInput(country: string, vatNumber: string, key: string): ManualFacturaInput {
	return manualFacturaInputSchema.parse({
		key,
		organizationId: "00000000-0000-4000-8000-000000000001",
		recipient: { name: "Customer Ltd", addressLine1: "Street 1", city: "City", country, vatNumber },
		chargeableDate: "2027-01-01",
		lines: [{ description: "Alethia Enterprise, January 2027", quantity: 2, unitAmount: "500.00" }],
	});
}

describe("the monthly фактура to Paddle (outside scope, Art. 21(2))", () => {
	it("dry run proposes the document without taking a number", async () => {
		const { db, manual } = memoryDb();
		const out = await proposeManualFactura(paddleInput(), deps(manual));
		expect(out.ok).toBe(true);
		if (!out.ok) return;
		expect(db.last).toBe(0);
		expect(db.rows).toHaveLength(0);
		expect(out.snapshot.number).toBe(PROPOSED_NUMBER);
		expect(out.existing).toBeNull();
		expect(out.warnings).toEqual([]);
	});

	it("prints 0 VAT, the Art. 21(2) ground, the customer's VAT number and the supplier's", async () => {
		const { manual, db } = memoryDb();
		const out = await issueManualFactura(paddleInput(), deps(manual));
		expect(out.ok).toBe(true);
		if (!out.ok) return;
		expect(out.document.number).toBe("0000000001");
		expect(out.replayed).toBe(false);
		const [row] = db.rows;
		expect(row.source).toBe("manual");
		expect(row.manualKey).toBe("paddle-market:2026-12");
		expect(row.organizationId).toBeNull();
		expect(row.stripeInvoiceId).toBeNull();
		expect(row.pdfKey).toBe("manual/0000000001.pdf");
		const s = row.snapshot;
		expect(s.vatTreatment).toBe("outside_scope");
		expect(s.taxBaseMinor).toBe(123456);
		expect(s.vatMinor).toBe(0);
		expect(s.totalMinor).toBe(123456);
		expect(s.noVatGround).toBe(GROUND_OUTSIDE_SCOPE);
		expect(s.eurEquivalent).toBeNull();
		const text = layoutText(facturaLayout(s));
		expect(text).toContain("ДДС № / VAT No.: GB123456789");
		expect(text).toContain("ДДС № / VAT No.: BG208913663");
		expect(text).toContain("ЕИК / Company ID: 208913663");
		expect(text).toContain(`Основание за неначисляване на ДДС / Ground for not charging VAT: ${GROUND_OUTSIDE_SCOPE}`);
		expect(text).toContain("Дата на данъчното събитие / Chargeable date: 31.12.2026");
		expect(text).toContain("Плащане по банков път / Payment by bank transfer");
		expect(text).toContain("Референция / Reference: Paddle payout reconciliation 2026-12");
		expect(text).not.toContain("Stripe");
		expect(text).toContain("/ United Kingdom");
		await expect(`${text}\n`).toMatchFileSnapshot("./golden/factura-manual-paddle.txt");
	});

	it("a re-run with the same key returns the issued фактура and takes no number", async () => {
		const { manual, db } = memoryDb();
		const d = deps(manual);
		await issueManualFactura(paddleInput(), d);
		const later = { ...d, now: () => new Date(Date.UTC(2027, 0, 4, 10, 0, 0)) };
		const again = await issueManualFactura(paddleInput(), later);
		expect(again.ok).toBe(true);
		if (!again.ok) return;
		expect(again.replayed).toBe(true);
		expect(again.document.number).toBe("0000000001");
		expect(db.last).toBe(1);
		const dry = await proposeManualFactura(paddleInput(), later);
		expect(dry.ok && dry.existing?.number).toBe("0000000001");
	});

	it("a re-run with the same key and a different amount is refused, not re-issued", async () => {
		const { manual, db } = memoryDb();
		const d = deps(manual);
		await issueManualFactura(paddleInput(), d);
		const changed = paddleInput({
			lines: [{ description: "x", quantity: 1, unitAmount: "1.00", periodStart: undefined, periodEnd: undefined }],
		});
		const out = await issueManualFactura(changed, d);
		expect(out).toMatchObject({ ok: false, reason: "idempotency_conflict" });
		expect(db.last).toBe(1);
	});

	it("a lost race returns the winner's row as a replay", async () => {
		const { manual, db } = memoryDb();
		const d = deps(manual);
		const proposed = await proposeManualFactura(paddleInput(), d);
		if (!proposed.ok) throw new Error(proposed.detail);
		// Another issuer inserts the same key between our lookup and our insert.
		manual.raceOnce = () => {
			db.last++;
			db.rows.push(
				rowOf("winner", {
					organizationId: null,
					source: "manual",
					manualKey: "paddle-market:2026-12",
					number: "0000000001",
					kind: "invoice",
					issueDate: "2027-01-02",
					chargeableDate: "2026-12-31",
					snapshot: { ...proposed.snapshot, number: "0000000001" },
				}),
			);
		};
		const out = await issueManualFactura(paddleInput(), d);
		expect(out).toMatchObject({ ok: true, replayed: true, document: { number: "0000000001" } });
		expect(db.last).toBe(1);
	});

	it("warns when issued more than five days after the chargeable event (Art. 113(4))", async () => {
		const { manual } = memoryDb();
		const out = await proposeManualFactura(paddleInput(), deps(manual, { now: () => new Date(Date.UTC(2027, 0, 9, 10)) }));
		expect(out.ok && out.warnings).toEqual(["issued 9 days after the chargeable event; Art. 113(4) ЗДДС asks for 5"]);
	});

	it("a USD фактура carries the EUR equivalent at the ECB rate of the chargeable date", async () => {
		const { manual } = memoryDb();
		const d = deps(manual);
		const out = await proposeManualFactura(paddleInput({ currency: "USD" }), d);
		expect(d.rateLookup).toHaveBeenCalledWith("USD", new Date("2026-12-31T12:00:00Z"));
		expect(out.ok && out.snapshot.eurEquivalent).toEqual({
			taxBaseEurMinor: 113580,
			vatEurMinor: 0,
			rate: "0.92000000",
			rateDate: "2027-01-14",
			source: "ECB:2027-01-14",
		});
	});

	it("refuses a non-EUR фактура when no ECB rate is published, before taking a number", async () => {
		const { manual, db } = memoryDb();
		const out = await issueManualFactura(paddleInput({ currency: "USD" }), deps(manual, { rateLookup: async () => null }));
		expect(out).toMatchObject({ ok: false, reason: "no_rate" });
		expect(db.last).toBe(0);
	});

	it("while the supplier is unregistered, prints the Stripe path's Art. 113(9) ground and no VAT number", async () => {
		const { manual, db } = memoryDb();
		const out = await issueManualFactura(paddleInput(), deps(manual, { supplier: { vatRegistered: false, vatNumber: null } }));
		expect(out.ok).toBe(true);
		const s = db.rows[0].snapshot;
		expect(s.vatTreatment).toBe("unregistered");
		expect(s.noVatGround).toBe("чл. 113, ал. 9 ЗДДС");
		expect(s.supplier.identifiers).toHaveLength(1);
	});

	it("refuses when the supplier is registered without a VAT number", async () => {
		const { manual, db } = memoryDb();
		const out = await issueManualFactura(paddleInput(), deps(manual, { supplier: { vatRegistered: true, vatNumber: null } }));
		expect(out).toMatchObject({ ok: false, reason: "supplier_vat_number_missing" });
		expect(db.last).toBe(0);
	});

	it("names a store failure without throwing", async () => {
		const { manual } = memoryDb();
		const broken = { ...manual, issue: async () => Promise.reject(new Error("db down")) };
		const out = await issueManualFactura(paddleInput(), deps(broken));
		expect(out).toMatchObject({ ok: false, reason: "store_failed" });
	});

	it("an issued фактура whose PDF fails is still issued; a re-run renders it", async () => {
		const { manual, db } = memoryDb();
		const failing = deps(manual, { render: async () => Promise.reject(new Error("render")) });
		const out = await issueManualFactura(paddleInput(), failing);
		expect(out).toMatchObject({ ok: false, reason: "pdf_failed" });
		expect(db.rows).toHaveLength(1);
		const again = await issueManualFactura(paddleInput(), deps(manual));
		expect(again).toMatchObject({ ok: true, replayed: true, document: { number: "0000000001" } });
		expect(db.rows[0].pdfKey).toBe("manual/0000000001.pdf");
	});
});

describe("Enterprise contracts", () => {
	it("a Bulgarian buyer is charged 20% VAT, printed with its rate and no no-VAT ground", async () => {
		const { manual, db } = memoryDb();
		const out = await issueManualFactura(enterpriseInput("BG", "BG123456789", "ent:bg:2027-01"), deps(manual));
		expect(out.ok).toBe(true);
		const [row] = db.rows;
		expect(row.organizationId).toBe("00000000-0000-4000-8000-000000000001");
		const s = row.snapshot;
		expect(s.vatTreatment).toBe("domestic");
		expect(s.vatRatePercent).toBe(20);
		expect(s.taxBaseMinor).toBe(100000);
		expect(s.vatMinor).toBe(20000);
		expect(s.totalMinor).toBe(120000);
		expect(s.noVatGround).toBeNull();
		const text = layoutText(facturaLayout(s));
		expect(text).toContain("ДДС 20% / VAT 20%: €200.00");
		expect(text).not.toContain("Основание за неначисляване");
		await expect(`${text}\n`).toMatchFileSnapshot("./golden/factura-manual-domestic.txt");
	});

	it("a business in another member state is invoiced under the reverse charge", async () => {
		const { manual, db } = memoryDb();
		await issueManualFactura(enterpriseInput("DE", "DE123456789", "ent:de:2027-01"), deps(manual));
		const s = db.rows[0].snapshot;
		expect(s.vatTreatment).toBe("eu_reverse_charge");
		expect(s.vatMinor).toBe(0);
		expect(s.noVatGround).toBe(GROUND_EU_REVERSE_CHARGE);
	});

	it("a re-run of the key for another organization is refused", async () => {
		const { manual } = memoryDb();
		const input = enterpriseInput("BG", "BG123456789", "ent:bg:2027-01");
		await issueManualFactura(input, deps(manual));
		const other = { ...input, organizationId: "00000000-0000-4000-8000-000000000009" };
		expect(await issueManualFactura(other, deps(manual))).toMatchObject({ ok: false, reason: "idempotency_conflict" });
	});

	it("a business in another member state without that state's VAT number is refused", async () => {
		const { manual, db } = memoryDb();
		const out = await issueManualFactura(enterpriseInput("DE", "FR12345678901", "ent:de2:2027-01"), deps(manual));
		expect(out).toMatchObject({ ok: false, reason: "eu_buyer_without_vat_number" });
		expect(db.last).toBe(0);
	});
});

describe("one series for both sources", () => {
	it("manual and Stripe фактури take consecutive numbers from the same counter", async () => {
		const { manual, stripe, db } = memoryDb();
		const md = deps(manual);
		const sd = { store: stripe, pdfStorage: md.pdfStorage, render: md.render, rateLookup: md.rateLookup, supplier: { vatRegistered: false }, now: md.now };
		const a = await requestFactura(paidInvoice({ id: "in_a" }), "00000000-0000-4000-8000-000000000002", sd);
		const b = await issueManualFactura(paddleInput(), md);
		const c = await requestFactura(paidInvoice({ id: "in_c" }), "00000000-0000-4000-8000-000000000002", sd);
		const d = await issueManualCreditNote(
			manualCreditNoteInputSchema.parse({ key: "paddle-market:2026-12:cn1", originalNumber: "0000000002", amount: "34.56", reason: "Paddle adjustment", chargeableDate: "2027-01-02" }),
			md,
		);
		expect([a, b, c, d].map((o) => (o.ok ? ("factura" in o ? o.factura.number : o.document.number) : o.reason))).toEqual([
			"0000000001",
			"0000000002",
			"0000000003",
			"0000000004",
		]);
		expect(db.rows.map((r) => r.source)).toEqual(["stripe", "manual", "stripe", "manual"]);
	});
});

describe("manual credit notes", () => {
	/** A store holding the issued Paddle фактура 0000000001. */
	async function withPaddleFactura(input = paddleInput()) {
		const m = memoryDb();
		const d = deps(m.manual);
		const out = await issueManualFactura(input, d);
		if (!out.ok) throw new Error(out.detail);
		return { ...m, d };
	}

	/** A credit-note input. */
	function cn(over: Partial<ManualCreditNoteInput> = {}): ManualCreditNoteInput {
		return manualCreditNoteInputSchema.parse({
			key: "paddle-market:2026-12:cn1",
			originalNumber: "0000000001",
			amount: "234.56",
			reason: "Корекция на нетните постъпления / Correction of net proceeds",
			chargeableDate: "2027-01-02",
			...over,
		});
	}

	it("a partial credit reduces the taxable amount, names the фактура and keeps its ground", async () => {
		const { db, d } = await withPaddleFactura();
		const out = await issueManualCreditNote(cn(), d);
		expect(out).toMatchObject({ ok: true, replayed: false, document: { number: "0000000002" } });
		const row = db.rows[1];
		expect(row.kind).toBe("credit_note");
		expect(row.originalFacturaId).toBe("f1");
		expect(row.source).toBe("manual");
		expect(row.pdfKey).toBe("manual/0000000002.pdf");
		const s = row.snapshot;
		expect(s.taxBaseMinor).toBe(-23456);
		expect(s.vatMinor).toBe(0);
		expect(s.totalMinor).toBe(-23456);
		expect(s.noVatGround).toBe(GROUND_OUTSIDE_SCOPE);
		expect(s.original).toEqual({ number: "0000000001", issueDate: "2027-01-02" });
		const text = layoutText(facturaLayout(s));
		expect(text).toContain("Към фактура / Corrects invoice: № 0000000001 от 02.01.2027");
		expect(text).toContain("Reduction of the taxable amount of invoice No. 0000000001");
		expect(text).toContain("Основание за издаване / Reason for issue: Корекция на нетните постъпления");
		expect(text).toContain("Уреждане по банков път / Settled by bank transfer");
	});

	it("a full credit of a 20% фактура negates its VAT exactly; a partial one charges the rate", async () => {
		const { db, d } = await withPaddleFactura(enterpriseInput("BG", "BG123456789", "ent:bg:2027-01"));
		await issueManualCreditNote(cn({ originalNumber: "0000000001", amount: "100.05", key: "cn-part" }), d);
		expect(db.rows[1].snapshot).toMatchObject({ taxBaseMinor: -10005, vatMinor: -2001, totalMinor: -12006, vatRatePercent: 20 });
		const full = await proposeManualCreditNote(cn({ originalNumber: "0000000001", amount: undefined, key: "cn-full" }), d);
		// 1000.00 minus the 100.05 already credited leaves less than the whole фактура.
		expect(full).toMatchObject({ ok: false, reason: "over_credit" });
		const { db: db2, d: d2 } = await withPaddleFactura(enterpriseInput("BG", "BG123456789", "ent:bg:2027-01"));
		await issueManualCreditNote(cn({ amount: undefined, key: "cn-full" }), d2);
		expect(db2.rows[1].snapshot).toMatchObject({ taxBaseMinor: -100000, vatMinor: -20000, totalMinor: -120000 });
		expect(db2.rows[1].snapshot.lines.map((l) => l.amountMinor)).toEqual([-100000]);
	});

	it("is idempotent on its key, and refuses the key reused with different content", async () => {
		const { db, d } = await withPaddleFactura();
		await issueManualCreditNote(cn(), d);
		const again = await issueManualCreditNote(cn(), d);
		expect(again).toMatchObject({ ok: true, replayed: true, document: { number: "0000000002" } });
		const dry = await proposeManualCreditNote(cn(), d);
		expect(dry.ok && dry.existing?.number).toBe("0000000002");
		const changed = await issueManualCreditNote(cn({ amount: "1.00" }), d);
		expect(changed).toMatchObject({ ok: false, reason: "idempotency_conflict" });
		const reusedInvoiceKey = await issueManualCreditNote(cn({ key: "paddle-market:2026-12" }), d);
		expect(reusedInvoiceKey).toMatchObject({ ok: false, reason: "idempotency_conflict" });
		expect(db.last).toBe(2);
	});

	it("refuses to credit beyond the фактура, an unknown number, a Stripe фактура, or nothing", async () => {
		const { db, d, stripe } = await withPaddleFactura();
		expect(await issueManualCreditNote(cn({ amount: "1234.57" }), d)).toMatchObject({ ok: false, reason: "over_credit" });
		expect(await issueManualCreditNote(cn({ amount: "0" }), d)).toMatchObject({ ok: false, reason: "over_credit" });
		expect(await issueManualCreditNote(cn({ originalNumber: "0000000099" }), d)).toMatchObject({ ok: false, reason: "no_original" });
		await requestFactura(paidInvoice(), "00000000-0000-4000-8000-000000000002", {
			store: stripe,
			pdfStorage: d.pdfStorage,
			render: d.render,
			rateLookup: d.rateLookup,
			supplier: { vatRegistered: false },
			now: d.now,
		});
		expect(await issueManualCreditNote(cn({ originalNumber: "0000000002" }), d)).toMatchObject({
			ok: false,
			reason: "original_not_manual",
		});
		expect(db.last).toBe(2);
	});

	it("names a store failure without throwing", async () => {
		const { d, manual } = await withPaddleFactura();
		const out = await issueManualCreditNote(cn(), { ...d, store: { ...manual, issue: async () => Promise.reject(new Error("x")) } });
		expect(out).toMatchObject({ ok: false, reason: "store_failed" });
	});
});

describe("input validation", () => {
	it("rejects a recipient without an identification number, address or valid country", () => {
		const bad = manualFacturaInputSchema.safeParse({
			key: "k-1",
			recipient: { name: "X", addressLine1: "", city: "C", country: "GBR" },
			chargeableDate: "2026-12-31",
			lines: [{ description: "d", unitAmount: "1.00" }],
		});
		expect(bad.success).toBe(false);
		const paths = bad.error?.issues.map((i) => i.path.join(".")) ?? [];
		expect(paths).toEqual(expect.arrayContaining(["recipient.addressLine1", "recipient.country"]));
		const noId = manualFacturaInputSchema.safeParse({
			key: "k-1",
			recipient: { name: "X", addressLine1: "A", city: "C", country: "GB" },
			chargeableDate: "2026-12-31",
			lines: [{ description: "d", unitAmount: "1.00" }],
		});
		expect(noId.error?.issues.map((i) => i.path.join("."))).toEqual(["recipient.vatNumber"]);
	});

	it("rejects bad amounts, dates, keys, periods and an empty total", () => {
		const base = {
			key: "k-1",
			recipient: { name: "X", addressLine1: "A", city: "C", country: "GB", companyId: "123" },
			chargeableDate: "2026-12-31",
		};
		const issues = (over: object) =>
			manualFacturaInputSchema.safeParse({ ...base, ...over }).error?.issues.map((i) => i.path.join(".")) ?? [];
		expect(issues({ lines: [{ description: "d", unitAmount: "1.234" }] })).toEqual(["lines.0.unitAmount"]);
		expect(issues({ lines: [{ description: "d", unitAmount: "-1" }] })).toEqual(["lines.0.unitAmount"]);
		expect(issues({ lines: [{ description: "d", unitAmount: "0.00" }] })).toEqual(["lines"]);
		expect(issues({ lines: [] })).toEqual(["lines"]);
		expect(issues({ chargeableDate: "2026-02-30", lines: [{ description: "d", unitAmount: "1" }] })).toEqual(["chargeableDate"]);
		expect(issues({ key: "a", lines: [{ description: "d", unitAmount: "1" }] })).toEqual(["key"]);
		expect(issues({ lines: [{ description: "d", unitAmount: "1", periodStart: "2026-12-01" }] })).toEqual(["lines.0.periodEnd"]);
		expect(
			issues({ lines: [{ description: "d", unitAmount: "1", periodStart: "2026-12-31", periodEnd: "2026-12-01" }] }),
		).toEqual(["lines.0.periodEnd"]);
		expect(issues({ currency: "JPY", lines: [{ description: "d", unitAmount: "100.50" }] })).toEqual(["lines.0.unitAmount"]);
		expect(issues({ organizationId: "not-a-uuid", lines: [{ description: "d", unitAmount: "1" }] })).toEqual(["organizationId"]);
	});

	it("rejects a credit note without a reason or with a malformed original number", () => {
		const out = manualCreditNoteInputSchema.safeParse({ key: "cn-1", originalNumber: "12", reason: "", chargeableDate: "2027-01-01" });
		expect(out.error?.issues.map((i) => i.path.join("."))).toEqual(["originalNumber", "reason"]);
	});

	it("converts decimal amounts to minor units without float error", () => {
		expect(toMinor("0.29", "EUR")).toBe(29);
		expect(toMinor("1.5", "EUR")).toBe(150);
		expect(toMinor("1234", "eur")).toBe(123400);
		expect(toMinor("100", "JPY")).toBe(100);
		expect(toMinor("100.00", "JPY")).toBe(100);
		expect(toMinor("100.5", "JPY")).toBeNull();
	});
});
