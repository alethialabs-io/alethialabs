// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The `manual` source of the фактура pipeline (L6b): an operator issues a фактура, or the credit
// note correcting one, for a supply no checkout produced. Two uses today:
//  - the monthly фактура from Alethia Labs to Paddle.com Market Ltd (UK) for the net supplier
//    proceeds of the month: Paddle is the merchant of record, so our supply is a B2B service to a
//    business outside the EU, no Bulgarian VAT under Art. 21(2) ЗДДС (vat-treatment.ts);
//  - an Enterprise contract invoiced and paid by bank transfer: domestic 20%, EU reverse charge or
//    outside scope, decided by the same module from the buyer's country and VAT number.
// The operator runs it through `pnpm factura:issue-manual` (manual-cli.ts), dry-run by default.
//
// SAME PIPELINE AS STRIPE, deliberately. The number comes from the one series in the same
// transaction (`issueInSeries`, issue.ts), so manual and automatic фактури interleave without a gap;
// the document is the same FacturaSnapshot, rendered by the same PDF renderer, kept immutable by the
// same trigger and exported by the same monthly export. What differs is only where the content comes
// from: a zod-validated operator input instead of a paid Stripe invoice.
//
// THE ORDER OF WRITES is issue.ts's: the input is validated, the VAT treatment decided and the EUR
// rate looked up BEFORE a number is taken, so a document that could not be compliant never spends
// one. Then number and snapshot in one transaction, then the PDF.
//
// IDEMPOTENT on the operator's key (`factura.manual_key`, unique). A re-run with the same key and
// the same content finds the issued document and returns it without a new number; a re-run with the
// same key and DIFFERENT content is refused (`idempotency_conflict`), because returning the old
// document would silently drop the change and issuing a new one would double-issue the supply. A
// correction of an issued manual фактура is a manual credit note, with its own key.
//
// It never throws for a document it cannot issue; the outcome names why. Server-only.

import { LEGAL_ENTITY } from "@repo/legal/entity";
import { stripeChargeDivisor } from "@repo/format";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { ecbEurRate, type EurRate, type EurRateLookup, toEurMinor } from "@/lib/billing/ecb-rate";
import { getServiceDb } from "@/lib/db";
import { type Factura, type FacturaInsert, factura } from "@/lib/db/schema";
import { log } from "@/lib/observability/log";
import { storage } from "@/lib/storage";
import type { FacturaLine, FacturaParty, FacturaSnapshot } from "@/types/jsonb.types";
import { isLegalInvoiceNumber } from "./checks";
import { buildCreditNoteSnapshot } from "./credit-note-snapshot";
import {
	dbFacturaStore,
	documentFor,
	type FacturaPdfStorage,
	type IssuedFactura,
	issueInSeries,
	sofiaDay,
} from "./issue";
import { renderFacturaPdf } from "./render-pdf";
import { FACTURA_DOCUMENT_NAME, rateDate, supplierParty } from "./snapshot";
import {
	decideVatTreatment,
	type SupplierVatFacts,
	type VatTreatment,
	type VatTreatmentRefusal,
	vatAmountMinor,
} from "./vat-treatment";

/** Art. 113(4) ЗДДС: a фактура is issued within this many days of the chargeable event. */
const ISSUE_DEADLINE_DAYS = 5;

/** What the number reads as on a dry-run proposal, before the series assigns one. */
export const PROPOSED_NUMBER = "(номер при издаване / assigned at issue)";

// ── Input ─────────────────────────────────────────────────────────────────────

/** An operator key: letters, digits and `:._-`, 3-128 characters, e.g. `paddle-market:2026-12`. */
const keySchema = z
	.string()
	.trim()
	.regex(/^[A-Za-z0-9][A-Za-z0-9:._-]{2,127}$/, "the key is 3-128 letters, digits or :._- and starts with a letter or digit");

/** A calendar date, YYYY-MM-DD. */
const daySchema = z.iso.date();

/** The shape of an amount: a non-negative decimal in major units, at most two decimals. */
const AMOUNT_PATTERN = /^\d{1,10}(\.\d{1,2})?$/;

/** A non-negative decimal amount in major units, at most two decimals: "1234.56". */
const amountSchema = z
	.string()
	.trim()
	.regex(AMOUNT_PATTERN, "an amount is a decimal in major units with at most two decimals, e.g. 1234.56");

/** The buyer, as printed (Art. 114(1), points 3-5). */
const recipientSchema = z
	.object({
		name: z.string().trim().min(1).max(200),
		addressLine1: z.string().trim().min(1).max(200),
		addressLine2: z.string().trim().max(200).optional(),
		postalCode: z.string().trim().max(20).optional(),
		city: z.string().trim().min(1).max(100),
		state: z.string().trim().max(100).optional(),
		country: z
			.string()
			.trim()
			.regex(/^[A-Za-z]{2}$/, "the country is an ISO 3166-1 alpha-2 code")
			.transform((c) => c.toUpperCase()),
		vatNumber: z
			.string()
			.transform((v) => v.replace(/[\s.-]/g, "").toUpperCase())
			.pipe(z.string().regex(/^[A-Z]{2}[0-9A-Z+*]{2,13}$/, "a VAT number starts with its two-letter prefix"))
			.optional(),
		companyId: z.string().trim().min(1).max(50).optional(),
	})
	.refine((r) => Boolean(r.vatNumber || r.companyId), {
		message: "the recipient needs an identification number: a VAT number or a company id (Art. 114(1))",
		path: ["vatNumber"],
	});

/** One line of the фактура (Art. 114(1), points 8-10). */
const lineSchema = z
	.object({
		description: z.string().trim().min(1).max(300),
		quantity: z.number().int().min(1).max(1_000_000).default(1),
		unitAmount: amountSchema,
		periodStart: daySchema.optional(),
		periodEnd: daySchema.optional(),
	})
	.refine((l) => (l.periodStart === undefined) === (l.periodEnd === undefined), {
		message: "a service period has both a start and an end",
		path: ["periodEnd"],
	})
	.refine((l) => !l.periodStart || !l.periodEnd || l.periodStart <= l.periodEnd, {
		message: "the service period ends before it starts",
		path: ["periodEnd"],
	});

/** A currency, ISO 4217, upper-cased. */
const currencySchema = z
	.string()
	.trim()
	.regex(/^[A-Za-z]{3}$/, "the currency is an ISO 4217 code")
	.transform((c) => c.toUpperCase());

/** The operator's input for a manual фактура (a JSON file, or the CLI's flags). */
export const manualFacturaInputSchema = z
	.object({
		key: keySchema,
		/** The console organization billed, for an Enterprise customer: its members can then read it. */
		organizationId: z.uuid().optional(),
		recipient: recipientSchema,
		/** The date of the chargeable event (Art. 25): for Paddle, the last day of the month. */
		chargeableDate: daySchema,
		currency: currencySchema.default("EUR"),
		lines: z.array(lineSchema).min(1).max(50),
		/** A contract number or payout id, printed as the reference. */
		reference: z.string().trim().min(1).max(120).optional(),
	})
	.superRefine((input, ctx) => {
		// Zod runs this even when a line's amount already failed its pattern; the total of malformed
		// amounts means nothing, so only well-formed inputs are summed.
		if (input.lines.length === 0 || !input.lines.every((l) => AMOUNT_PATTERN.test(l.unitAmount))) return;
		let whole = true;
		input.lines.forEach((l, i) => {
			if (toMinor(l.unitAmount, input.currency) === null) {
				whole = false;
				ctx.addIssue({
					code: "custom",
					message: `${input.currency} has no minor unit, so the amount must be whole`,
					path: ["lines", i, "unitAmount"],
				});
			}
		});
		if (!whole) return;
		const total = input.lines.reduce((sum, l) => sum + (toMinor(l.unitAmount, input.currency) ?? 0) * l.quantity, 0);
		if (total <= 0) ctx.addIssue({ code: "custom", message: "the фактура adds up to nothing", path: ["lines"] });
		if (!Number.isSafeInteger(total)) ctx.addIssue({ code: "custom", message: "the total is too large", path: ["lines"] });
	});

/** A validated manual фактура input. */
export type ManualFacturaInput = z.output<typeof manualFacturaInputSchema>;

/** The operator's input for a manual credit note against a manual фактура. */
export const manualCreditNoteInputSchema = z.object({
	key: keySchema,
	/** The number of the manual фактура corrected. */
	originalNumber: z.string().trim().regex(/^[0-9]{10}$/, "the original is a ten-digit фактура number"),
	/** The reduction of the TAXABLE amount, in the original's currency; omitted, the whole фактура. */
	amount: amountSchema.optional(),
	/** Why (Art. 115(3)), printed on the document. */
	reason: z.string().trim().min(3).max(300),
	/** The date of the event that reduced the tax base. */
	chargeableDate: daySchema,
});

/** A validated manual credit-note input. */
export type ManualCreditNoteInput = z.output<typeof manualCreditNoteInputSchema>;

/**
 * A decimal amount in major units as an integer in `currency`'s minor unit, or null when the
 * currency has no minor unit and the amount has a fractional part. String arithmetic only: a float
 * would turn "0.29" into 28.999….
 */
export function toMinor(decimal: string, currency: string): number | null {
	const [whole, frac = ""] = decimal.split(".");
	if (stripeChargeDivisor(currency) === 1) return /^0*$/.test(frac) ? Number(whole) : null;
	return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}

// ── Outcomes and dependencies ─────────────────────────────────────────────────

/**
 * Why no manual document was issued.
 *  - `supplier_vat_number_missing`, `eu_buyer_without_vat_number`, `no_ground_ruling`: the VAT
 *    treatment cannot be decided (vat-treatment.ts);
 *  - `no_rate`: not EUR, and no ECB rate for the chargeable date (Art. 114(5));
 *  - `idempotency_conflict`: the key was already used for a different document;
 *  - `no_original`, `original_not_manual`, `over_credit`: a credit note has nothing (manual) to
 *    correct, or would credit more than the фактура;
 *  - `store_failed`, `pdf_failed`, `pdf_integrity`: as for a Stripe фактура (checks.ts).
 */
export type ManualFailure =
	| VatTreatmentRefusal
	| "no_rate"
	| "idempotency_conflict"
	| "no_original"
	| "original_not_manual"
	| "over_credit"
	| "store_failed"
	| "pdf_failed"
	| "pdf_integrity";

/** A refusal: the reason and a sentence for the operator. */
export interface ManualRefusal {
	ok: false;
	reason: ManualFailure;
	detail: string;
}

/** What a dry run shows: the document as it would be issued, and what the operator should know. */
export interface ManualProposal {
	ok: true;
	snapshot: FacturaSnapshot;
	/** Non-blocking findings, e.g. issued after the Art. 113(4) five days. */
	warnings: string[];
	/** The document already issued under this key with the same content, when there is one. */
	existing: Factura | null;
}

/** An issued (or, on a re-run, found) manual document with its PDF. */
export interface ManualIssued {
	ok: true;
	document: IssuedFactura;
	/** True when the key had already been issued and the existing document was returned. */
	replayed: boolean;
	warnings: string[];
}

/** The database side of the manual source. */
export interface ManualFacturaStore {
	/** The document issued under an operator key, or null. */
	findByManualKey(key: string): Promise<Factura | null>;
	/** The document with a number, or null. */
	findByNumber(number: string): Promise<Factura | null>;
	/** `issueInSeries` keyed by the manual key: the new row, or null when the key won a race first. */
	issue(build: (number: string) => FacturaInsert): Promise<Factura | null>;
	/** Attaches the PDF to a row that has none yet. */
	attachPdf(id: string, pdfKey: string, pdfSha256: string): Promise<void>;
	/** The sum, as a positive amount in minor units, of the taxable amounts credited against a фактура. */
	creditedBaseMinor(originalFacturaId: string): Promise<number>;
}

/** Everything the manual source reads from outside, replaceable in tests. */
export interface ManualDeps {
	store: ManualFacturaStore;
	pdfStorage: FacturaPdfStorage;
	rateLookup: EurRateLookup;
	render: typeof renderFacturaPdf;
	supplier: SupplierVatFacts;
	now: () => Date;
}

/** The Postgres store, through the service role. */
const dbManualFacturaStore: ManualFacturaStore = {
	async findByManualKey(key) {
		const [row] = await getServiceDb().select().from(factura).where(eq(factura.manualKey, key)).limit(1);
		return row ?? null;
	},
	async findByNumber(number) {
		const [row] = await getServiceDb().select().from(factura).where(eq(factura.number, number)).limit(1);
		return row ?? null;
	},
	issue: (build) => issueInSeries(build, "manual"),
	attachPdf: dbFacturaStore.attachPdf,
	async creditedBaseMinor(originalFacturaId) {
		const [row] = await getServiceDb()
			.select({ total: sql<string>`coalesce(sum(-(${factura.snapshot}->>'taxBaseMinor')::bigint), 0)` })
			.from(factura)
			.where(and(eq(factura.originalFacturaId, originalFacturaId), eq(factura.kind, "credit_note")));
		return Number(row?.total ?? 0);
	},
};

/** The production dependencies. */
const defaultDeps: ManualDeps = {
	store: dbManualFacturaStore,
	pdfStorage: storage,
	rateLookup: ecbEurRate,
	render: renderFacturaPdf,
	supplier: LEGAL_ENTITY,
	now: () => new Date(),
};

/** A refusal. */
function refuse(reason: ManualFailure, detail: string): ManualRefusal {
	return { ok: false, reason, detail };
}

// ── The document ──────────────────────────────────────────────────────────────

/** The recipient block from the operator's input. */
function recipientParty(r: ManualFacturaInput["recipient"]): FacturaParty {
	const town = [r.postalCode, r.city].filter(Boolean).join(" ");
	return {
		name: r.name,
		addressLines: [r.addressLine1, r.addressLine2, town, r.state].filter(
			(v): v is string => typeof v === "string" && v !== "",
		),
		country: r.country,
		identifiers: [
			...(r.vatNumber ? [{ label: "ДДС № / VAT No.", value: r.vatNumber }] : []),
			...(r.companyId ? [{ label: "Идент. № / ID No.", value: r.companyId }] : []),
		],
	};
}

/** What the snapshot needs beyond the input. */
interface ManualSnapshotInputs {
	number: string;
	issueDate: string;
	vat: VatTreatment;
	supplierVatNumber: string | null;
	eurRate: EurRate | null;
}

/** The snapshot of a manual фактура. Pure, so a dry run shows exactly what `--issue` stores. */
function buildManualSnapshot(input: ManualFacturaInput, s: ManualSnapshotInputs): FacturaSnapshot {
	const lines: FacturaLine[] = input.lines.map((l) => {
		const unit = toMinor(l.unitAmount, input.currency) ?? 0;
		return {
			description: l.description,
			quantity: l.quantity,
			unitAmountMinor: unit,
			amountMinor: unit * l.quantity,
			periodStart: l.periodStart ?? null,
			periodEnd: l.periodEnd ?? null,
		};
	});
	const taxBaseMinor = lines.reduce((sum, l) => sum + l.amountMinor, 0);
	const vatMinor = vatAmountMinor(taxBaseMinor, s.vat.ratePercent);
	const eurRate = input.currency === "EUR" ? null : s.eurRate;
	return {
		version: 1,
		documentName: FACTURA_DOCUMENT_NAME,
		number: s.number,
		issueDate: s.issueDate,
		chargeableDate: input.chargeableDate,
		supplier: supplierParty(s.supplierVatNumber),
		recipient: recipientParty(input.recipient),
		lines,
		currency: input.currency,
		taxBaseMinor,
		vatMinor,
		totalMinor: taxBaseMinor + vatMinor,
		noVatGround: s.vat.ground,
		eurEquivalent: eurRate
			? {
					taxBaseEurMinor: toEurMinor(taxBaseMinor, input.currency, eurRate),
					vatEurMinor: toEurMinor(vatMinor, input.currency, eurRate),
					rate: eurRate.eurPerUnit,
					rateDate: rateDate(eurRate, input.chargeableDate),
					source: eurRate.source,
				}
			: null,
		original: null,
		stripeInvoiceNumber: null,
		source: "manual",
		vatTreatment: s.vat.treatment,
		vatRatePercent: s.vat.ratePercent || null,
		reference: input.reference ?? null,
	};
}

/**
 * What makes two manual documents the same supply: everything printed except the number and the
 * issue date (a re-run on a later day is still the same document).
 */
function contentOf(s: FacturaSnapshot): string {
	return JSON.stringify([
		s.documentName,
		s.chargeableDate,
		s.supplier,
		s.recipient,
		s.lines,
		s.currency,
		s.taxBaseMinor,
		s.vatMinor,
		s.totalMinor,
		s.noVatGround,
		s.eurEquivalent,
		s.original,
		s.reason ?? null,
		s.vatRatePercent ?? null,
		s.reference ?? null,
	]);
}

/** Whole days from `from` to `to` (YYYY-MM-DD). */
function daysBetween(from: string, to: string): number {
	return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** The Art. 113(4) finding for a document issued on `issueDate` for an event on `chargeableDate`. */
function deadlineWarnings(chargeableDate: string, issueDate: string): string[] {
	const late = daysBetween(chargeableDate, issueDate);
	return late > ISSUE_DEADLINE_DAYS
		? [`issued ${late} days after the chargeable event; Art. 113(4) ЗДДС asks for ${ISSUE_DEADLINE_DAYS}`]
		: [];
}

/** The existing row under `key`, refused when it is not the document now asked for. */
function sameOrConflict(existing: Factura, proposed: FacturaSnapshot, key: string): ManualRefusal | null {
	if (contentOf(existing.snapshot) === contentOf(proposed)) return null;
	return refuse(
		"idempotency_conflict",
		`key ${key} was already used for ${existing.kind === "credit_note" ? "credit note" : "фактура"} ${existing.number} ` +
			"with different content; correct an issued фактура with a credit note under a new key",
	);
}

/** The existing row under `key`, refused when it was issued to another console organization. */
function sameOrganization(existing: Factura, organizationId: string | null, key: string): ManualRefusal | null {
	if (existing.organizationId === organizationId) return null;
	return refuse(
		"idempotency_conflict",
		`key ${key} was already used for фактура ${existing.number} of ${existing.organizationId ?? "no organization"}`,
	);
}

/** A failure of `documentFor` as a manual refusal. */
function fromDocument(reason: string, detail: string): ManualRefusal {
	return refuse(reason === "pdf_integrity" ? "pdf_integrity" : reason === "pdf_failed" ? "pdf_failed" : "store_failed", detail);
}

/**
 * The manual фактура `input` as it would be issued now, without taking a number: the dry run.
 * Refuses exactly what `issueManualFactura` would refuse before taking a number.
 */
export async function proposeManualFactura(
	input: ManualFacturaInput,
	deps: Partial<ManualDeps> = {},
): Promise<ManualProposal | ManualRefusal> {
	const all: ManualDeps = { ...defaultDeps, ...deps };
	const decision = decideVatTreatment(all.supplier, {
		country: input.recipient.country,
		vatNumber: input.recipient.vatNumber ?? null,
	});
	if (!decision.ok) return refuse(decision.reason, decision.detail);
	let eurRate: EurRate | null = null;
	if (input.currency !== "EUR") {
		eurRate = await all.rateLookup(input.currency, new Date(`${input.chargeableDate}T12:00:00Z`));
		if (!eurRate) {
			return refuse("no_rate", `no ECB reference rate for ${input.currency} on ${input.chargeableDate} (Art. 114(5))`);
		}
	}
	const issueDate = sofiaDay(all.now());
	const snapshot = buildManualSnapshot(input, {
		number: PROPOSED_NUMBER,
		issueDate,
		vat: decision.vat,
		supplierVatNumber: all.supplier.vatRegistered ? all.supplier.vatNumber : null,
		eurRate,
	});
	const existing = await all.store.findByManualKey(input.key);
	if (existing) {
		const conflict =
			sameOrConflict(existing, snapshot, input.key) ?? sameOrganization(existing, input.organizationId ?? null, input.key);
		if (conflict) return conflict;
	}
	return { ok: true, snapshot, warnings: deadlineWarnings(input.chargeableDate, issueDate), existing };
}

/**
 * Issues the manual фактура `input`, or returns the one already issued under its key with the same
 * content. Never throws; a failure names its reason.
 */
export async function issueManualFactura(
	input: ManualFacturaInput,
	deps: Partial<ManualDeps> = {},
): Promise<ManualIssued | ManualRefusal> {
	const all: ManualDeps = { ...defaultDeps, ...deps };
	try {
		const proposal = await proposeManualFactura(input, all);
		if (!proposal.ok) return proposal;
		const warnings = proposal.warnings;
		if (proposal.existing) return finish(proposal.existing, true, warnings, all);

		const { snapshot } = proposal;
		const issued = await all.store.issue((number) => ({
			organizationId: input.organizationId ?? null,
			source: "manual",
			manualKey: input.key,
			number,
			kind: "invoice",
			issueDate: snapshot.issueDate,
			chargeableDate: snapshot.chargeableDate,
			snapshot: { ...snapshot, number },
		}));
		// Null: another issuer took the key first (its transaction won the race); return its row.
		const row = issued ?? (await all.store.findByManualKey(input.key));
		if (!row || !isLegalInvoiceNumber(row.number)) return refuse("store_failed", "the issued фактура could not be read back");
		const conflict = sameOrConflict(row, snapshot, input.key);
		if (conflict) return conflict;
		return finish(row, issued === null, warnings, all);
	} catch (err) {
		log.error("[factura] manual issue failed", { err, key: input.key });
		return refuse("store_failed", "the number and document could not be saved; nothing was issued");
	}
}

/** The PDF of an issued manual row, as the outcome of an issue. */
async function finish(
	row: Factura,
	replayed: boolean,
	warnings: string[],
	deps: ManualDeps,
): Promise<ManualIssued | ManualRefusal> {
	const outcome = await documentFor(row, deps);
	if (!outcome.ok) return fromDocument(outcome.reason, outcome.detail);
	return { ok: true, document: outcome.factura, replayed, warnings };
}

// ── Credit notes ──────────────────────────────────────────────────────────────

/** The original manual фактура and the credit note as it would be issued now. */
interface CreditNoteProposal {
	ok: true;
	original: Factura;
	snapshot: FacturaSnapshot;
	creditMinor: number;
	warnings: string[];
	existing: Factura | null;
}

/** The manual credit note `input` as it would be issued now, without taking a number: the dry run. */
export async function proposeManualCreditNote(
	input: ManualCreditNoteInput,
	deps: Partial<ManualDeps> = {},
): Promise<CreditNoteProposal | ManualRefusal> {
	const all: ManualDeps = { ...defaultDeps, ...deps };
	const original = await all.store.findByNumber(input.originalNumber);
	if (!original || original.kind !== "invoice") {
		return refuse("no_original", `no фактура numbered ${input.originalNumber} was issued`);
	}
	if (original.source !== "manual") {
		return refuse(
			"original_not_manual",
			`фактура ${original.number} came from Stripe; its credit notes follow its Stripe refunds (credit-note.ts)`,
		);
	}
	const currency = original.snapshot.currency;
	const creditMinor = input.amount === undefined ? original.snapshot.taxBaseMinor : toMinor(input.amount, currency);
	if (creditMinor === null || creditMinor <= 0) {
		return refuse("over_credit", `a credit of ${input.amount ?? "0"} ${currency} is not a positive amount in ${currency}`);
	}
	const issueDate = sofiaDay(all.now());
	const snapshot = buildCreditNoteSnapshot(original.snapshot, creditMinor, {
		number: PROPOSED_NUMBER,
		issueDate,
		chargeableDate: input.chargeableDate,
		reason: input.reason,
	});
	const existing = await all.store.findByManualKey(input.key);
	const warnings = deadlineWarnings(input.chargeableDate, issueDate);
	if (existing) {
		// Already issued under this key: the same document is returned, a different one refused. Its
		// own credit is in the credited sum, so the over-credit check below does not apply to it.
		const conflict = sameOrConflict(existing, snapshot, input.key);
		if (conflict) return conflict;
		return { ok: true, original, snapshot, creditMinor, warnings, existing };
	}
	const credited = await all.store.creditedBaseMinor(original.id);
	if (credited + creditMinor > original.snapshot.taxBaseMinor) {
		return refuse(
			"over_credit",
			`a credit of ${input.amount ?? "the whole фактура"} ${currency} would credit фактура ${original.number} beyond its taxable amount ` +
				`(${original.snapshot.taxBaseMinor}, already credited ${credited}, in minor units)`,
		);
	}
	return { ok: true, original, snapshot, creditMinor, warnings, existing: null };
}

/**
 * Issues the manual credit note `input` against a manual фактура, or returns the one already issued
 * under its key with the same content. Never throws; a failure names its reason.
 */
export async function issueManualCreditNote(
	input: ManualCreditNoteInput,
	deps: Partial<ManualDeps> = {},
): Promise<ManualIssued | ManualRefusal> {
	const all: ManualDeps = { ...defaultDeps, ...deps };
	try {
		const proposal = await proposeManualCreditNote(input, all);
		if (!proposal.ok) return proposal;
		if (proposal.existing) return finish(proposal.existing, true, proposal.warnings, all);
		const { snapshot, original } = proposal;
		const issued = await all.store.issue((number) => ({
			organizationId: original.organizationId,
			source: "manual",
			manualKey: input.key,
			number,
			kind: "credit_note",
			originalFacturaId: original.id,
			issueDate: snapshot.issueDate,
			chargeableDate: snapshot.chargeableDate,
			snapshot: { ...snapshot, number },
		}));
		const row = issued ?? (await all.store.findByManualKey(input.key));
		if (!row || !isLegalInvoiceNumber(row.number)) {
			return refuse("store_failed", "the issued credit note could not be read back");
		}
		const conflict = sameOrConflict(row, snapshot, input.key);
		if (conflict) return conflict;
		return finish(row, issued === null, proposal.warnings, all);
	} catch (err) {
		log.error("[factura] manual credit note failed", { err, key: input.key });
		return refuse("store_failed", "the number and credit note could not be saved; nothing was issued");
	}
}
