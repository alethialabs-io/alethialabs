// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Issues the Bulgarian фактура for a paid Stripe invoice (#7368). It replaces the Odoo client: the
// console takes the number, keeps the document, and renders the PDF itself. Stripe stays the
// payment rail; this is a thin layer on its paid invoice (ruling of 2026-11-23).
//
// THE ORDER OF WRITES, and why each step sits where it does:
//  1. The checks in `checks.ts`, and the EUR rate for a non-EUR invoice. All run BEFORE a number is
//     taken, so an invoice that cannot produce a compliant document never spends one.
//  2. One transaction takes the next number (UPDATE … RETURNING on `factura_series`) and inserts the
//     `factura` row with its snapshot. A rollback returns the number, and the database refuses to
//     commit a number with no row (programmables.sql), so the series has no gaps.
//  3. The PDF is rendered from the snapshot, stored, and attached to the row with its SHA-256. If
//     that fails, the фактура still exists (number and snapshot are committed), the outcome says
//     `pdf_failed`, and a replay of the event renders it again from the same snapshot.
//
// IDEMPOTENT on (Stripe invoice id, kind, refund id), the refund id NULL for a фактура: a replay finds the issued row and returns it. Two
// concurrent issuers for one invoice race on that unique key; the loser's insert does nothing, its
// transaction is rolled back (returning its number), and it returns the winner's row.
//
// It never throws. Every way of not producing a compliant фактура is a named `FacturaFailure`, and
// lib/billing/invoices.ts leaves the invoice pending and alerts the operator (EA-7).
// Server-only.

import { createHash } from "node:crypto";
import { LEGAL_ENTITY } from "@repo/legal/entity";
import { and, eq, isNull, sql } from "drizzle-orm";
import { ecbEurRate, type EurRate, type EurRateLookup } from "@/lib/billing/ecb-rate";
import { getServiceDb } from "@/lib/db";
import {
	FACTURA_SERIES_BG,
	type Factura,
	type FacturaInsert,
	factura,
	facturaSeries,
} from "@/lib/db/schema";
import { log } from "@/lib/observability/log";
import { storage } from "@/lib/storage";
import { creditNotePdfKey, INVOICE_PDF_BUCKET, invoicePdfKey } from "@/lib/storage/invoice-pdf";
import {
	type FacturaFailure,
	type FacturaSource,
	isLegalInvoiceNumber,
	missingRecipientDetails,
	noVatGround,
	type SupplierVatStatus,
	vatCharged,
} from "./checks";
import { renderFacturaPdf } from "./document";
import { buildFacturaSnapshot } from "./snapshot";

/** The issued фактура: what the invoice mirror records and the receipt attaches. */
export interface IssuedFactura {
	/** The ten-digit number (Art. 114(1), point 2), e.g. "0000000001". */
	number: string;
	/** ISO currency code, lower-case (Stripe's convention). */
	currency: string;
	/** The no-VAT ground the фактура states. */
	vatGround: string;
	/** The object-storage key of the PDF. */
	pdfKey: string;
	/** The PDF bytes. */
	pdf: Uint8Array;
}

/** The result of asking for a фактура: the compliant document, or why there is none. */
export type FacturaOutcome =
	| { ok: true; factura: IssuedFactura }
	| { ok: false; reason: FacturaFailure; detail: string };

/** The database side of issuing, so the order of writes is testable without Postgres. */
export interface FacturaStore {
	/** The issued фактура (kind `invoice`) for a Stripe invoice, or null. */
	findIssued(stripeInvoiceId: string): Promise<Factura | null>;
	/**
	 * In one transaction: takes the next number, builds the row from it, inserts it. Returns the new
	 * row, or null when another issuer inserted one for the same Stripe invoice first (the
	 * transaction is then rolled back, so the number taken here is returned).
	 */
	issue(build: (number: string) => FacturaInsert): Promise<Factura | null>;
	/** Attaches the PDF to a row that has none yet. */
	attachPdf(id: string, pdfKey: string, pdfSha256: string): Promise<void>;
}

/** Where PDFs are kept (the console's object storage satisfies it). */
export interface FacturaPdfStorage {
	put(bucket: string, key: string, body: Uint8Array, contentType: string): Promise<void>;
	get(bucket: string, key: string): Promise<Uint8Array | null>;
}

/** Everything `requestFactura` reads from outside, replaceable in tests. */
export interface IssueDeps {
	store: FacturaStore;
	pdfStorage: FacturaPdfStorage;
	rateLookup: EurRateLookup;
	render: typeof renderFacturaPdf;
	supplier: SupplierVatStatus;
	now: () => Date;
}

/** Thrown inside the issuing transaction to roll it back when another issuer won the race. */
class LostRace extends Error {}

/** The Postgres store, through the service role (the tables admit no app-role write). */
export const dbFacturaStore: FacturaStore = {
	async findIssued(stripeInvoiceId) {
		const [row] = await getServiceDb()
			.select()
			.from(factura)
			.where(and(eq(factura.stripeInvoiceId, stripeInvoiceId), eq(factura.kind, "invoice")))
			.limit(1);
		return row ?? null;
	},
	async issue(build) {
		try {
			return await getServiceDb().transaction(async (tx) => {
				const [series] = await tx
					.update(facturaSeries)
					.set({ lastNumber: sql`${facturaSeries.lastNumber} + 1`, updatedAt: new Date() })
					.where(eq(facturaSeries.id, FACTURA_SERIES_BG))
					.returning({ lastNumber: facturaSeries.lastNumber });
				if (!series) throw new Error(`factura series ${FACTURA_SERIES_BG} is not seeded`);
				const [row] = await tx
					.insert(factura)
					.values(build(String(series.lastNumber).padStart(10, "0")))
					.onConflictDoNothing({ target: [factura.stripeInvoiceId, factura.kind, factura.stripeRefundId] })
					.returning();
				if (!row) throw new LostRace();
				return row;
			});
		} catch (err) {
			if (err instanceof LostRace) return null;
			throw err;
		}
	},
	async attachPdf(id, pdfKey, pdfSha256) {
		await getServiceDb()
			.update(factura)
			.set({ pdfKey, pdfSha256 })
			.where(and(eq(factura.id, id), isNull(factura.pdfKey)));
	},
};

/** The production dependencies. */
const defaultDeps: IssueDeps = {
	store: dbFacturaStore,
	pdfStorage: storage,
	rateLookup: ecbEurRate,
	render: renderFacturaPdf,
	supplier: LEGAL_ENTITY,
	now: () => new Date(),
};

/** A date as YYYY-MM-DD in Sofia, where the supplier is established. */
export function sofiaDay(d: Date): string {
	// en-CA formats as YYYY-MM-DD.
	return new Intl.DateTimeFormat("en-CA", {
		timeZone: "Europe/Sofia",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(d);
}

/** Lower-case hex SHA-256 of `bytes`. */
function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/** A failed outcome. */
function fail(reason: FacturaFailure, detail: string): FacturaOutcome {
	return { ok: false, reason, detail };
}

/** Where an issued row's PDF is stored: per Stripe invoice for a фактура, per refund for a credit note. */
export function facturaPdfKey(row: Pick<Factura, "organizationId" | "stripeInvoiceId" | "stripeRefundId">): string {
	return row.stripeRefundId
		? creditNotePdfKey(row.organizationId, row.stripeInvoiceId, row.stripeRefundId)
		: invoicePdfKey(row.organizationId, row.stripeInvoiceId);
}

/**
 * The PDF of an issued row (a фактура or a credit note): the stored one, checked against its
 * SHA-256, or, when none is stored yet, rendered from the snapshot, stored and attached. Shared by
 * the credit-note issuer and the sweeper (#7369).
 */
export async function documentFor(
	row: Factura,
	deps: Pick<IssueDeps, "store" | "pdfStorage" | "render">,
): Promise<FacturaOutcome> {
	const issued = (pdfKey: string, pdf: Uint8Array): FacturaOutcome => ({
		ok: true,
		factura: {
			number: row.number,
			currency: row.snapshot.currency.toLowerCase(),
			vatGround: row.snapshot.noVatGround ?? "",
			pdfKey,
			pdf,
		},
	});
	if (row.pdfKey && row.pdfSha256) {
		const stored = await deps.pdfStorage.get(INVOICE_PDF_BUCKET, row.pdfKey).catch(() => null);
		if (stored && sha256(stored) === row.pdfSha256) return issued(row.pdfKey, stored);
		if (stored) {
			return fail("pdf_integrity", `the stored PDF of фактура ${row.number} does not match its recorded SHA-256`);
		}
		// Missing from storage: re-render. The render is reproducible, so the hash must match.
		const again = await deps.render(row.snapshot);
		if (sha256(again) !== row.pdfSha256) {
			return fail("pdf_integrity", `фактура ${row.number}'s PDF is missing and its re-render does not match the recorded SHA-256`);
		}
		await deps.pdfStorage.put(INVOICE_PDF_BUCKET, row.pdfKey, again, "application/pdf");
		return issued(row.pdfKey, again);
	}
	try {
		const pdf = await deps.render(row.snapshot);
		const key = facturaPdfKey(row);
		await deps.pdfStorage.put(INVOICE_PDF_BUCKET, key, pdf, "application/pdf");
		await deps.store.attachPdf(row.id, key, sha256(pdf));
		return issued(key, pdf);
	} catch (err) {
		log.error("[factura] PDF render or store failed", { err, number: row.number });
		return fail(
			"pdf_failed",
			`фактура ${row.number} is issued but its PDF could not be rendered or stored; replay the event to render it from the snapshot`,
		);
	}
}

/** Issues (or finds) the фактура and its PDF. The body of `requestFactura`, after the dedupe. */
async function issueFor(inv: FacturaSource & { id: string }, orgId: string, deps: IssueDeps): Promise<FacturaOutcome> {
	const missing = missingRecipientDetails(inv);
	if (missing.length) {
		return fail(
			"recipient_incomplete",
			`the recipient's ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} missing (Art. 114(1))`,
		);
	}
	const ground = noVatGround(deps.supplier);
	if (!ground) {
		return fail("no_ground_ruling", "the supplier is VAT-registered and no per-cell invoice ground is ruled for that");
	}
	if (vatCharged(inv)) {
		return fail("vat_charged", "the Stripe invoice carries tax, which a supplier not registered for VAT may not show (Art. 113(9))");
	}

	let existing: Factura | null;
	try {
		existing = await deps.store.findIssued(inv.id);
	} catch (err) {
		log.error("[factura] lookup failed", { err, invoice: inv.id });
		return fail("store_failed", "the фактура store could not be read");
	}
	if (existing) return documentFor(existing, deps);

	const paidAt = inv.status_transitions?.paid_at ? new Date(inv.status_transitions.paid_at * 1000) : deps.now();
	const chargeableDate = sofiaDay(paidAt);
	let rate: EurRate | null = null;
	if (inv.currency.toLowerCase() !== "eur") {
		rate = await deps.rateLookup(inv.currency, paidAt);
		if (!rate) {
			return fail(
				"no_rate",
				`no ECB reference rate for ${inv.currency.toUpperCase()} on ${chargeableDate} (Art. 114(5) needs the EUR equivalent)`,
			);
		}
	}
	const issueDate = sofiaDay(deps.now());

	let row: Factura | null;
	try {
		row = await deps.store.issue((number) => ({
			organizationId: orgId,
			number,
			kind: "invoice",
			stripeInvoiceId: inv.id,
			issueDate,
			chargeableDate,
			snapshot: buildFacturaSnapshot(inv, { number, issueDate, chargeableDate, noVatGround: ground, eurRate: rate }),
		}));
		row ??= await deps.store.findIssued(inv.id);
	} catch (err) {
		log.error("[factura] issue failed", { err, invoice: inv.id });
		return fail("store_failed", "the number and document could not be saved; nothing was issued");
	}
	if (!row || !isLegalInvoiceNumber(row.number)) {
		return fail("store_failed", "the issued фактура could not be read back");
	}
	return documentFor(row, deps);
}

// Dedupe concurrent issue+render for the same invoice within a process. The database is the real
// guard (the unique key); this only saves a second render.
const inflight = new Map<string, Promise<FacturaOutcome>>();

/**
 * The фактура of a paid Stripe invoice for organization `orgId`: issued now, or found when it was
 * issued before. Never throws; a failure names its reason. `deps` replaces the database, storage,
 * rate source, renderer, supplier status or clock in tests.
 */
export async function requestFactura(
	inv: FacturaSource,
	orgId: string,
	deps: Partial<IssueDeps> = {},
): Promise<FacturaOutcome> {
	const invoiceId = inv.id;
	if (!invoiceId) return fail("no_invoice_id", "the Stripe invoice has no id");
	const all: IssueDeps = { ...defaultDeps, ...deps };
	const cached = inflight.get(invoiceId);
	if (cached) return cached;
	const task = issueFor({ ...inv, id: invoiceId }, orgId, all).catch((err: unknown) => {
		log.error("[factura] unexpected failure", { err, invoice: invoiceId });
		return fail("store_failed", "the фактура could not be issued");
	});
	inflight.set(invoiceId, task);
	void task.finally(() => inflight.delete(invoiceId));
	return task;
}

/**
 * The фактура already issued for a Stripe invoice, with its PDF, or null. For the receipt email,
 * which runs after the invoice mirror has issued it and must never issue one itself.
 */
export async function issuedFacturaFor(
	stripeInvoiceId: string,
	deps: Partial<IssueDeps> = {},
): Promise<IssuedFactura | null> {
	const all: IssueDeps = { ...defaultDeps, ...deps };
	try {
		const row = await all.store.findIssued(stripeInvoiceId);
		if (!row) return null;
		const outcome = await documentFor(row, all);
		return outcome.ok ? outcome.factura : null;
	} catch (err) {
		log.error("[factura] lookup for the receipt failed", { err, invoice: stripeInvoiceId });
		return null;
	}
}
