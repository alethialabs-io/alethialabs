// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// One month's VAT position of a company registered ONLY under чл. 97а ЗДДС (#7457): which documents
// go in which journal, the чл. 117 protocols for the services it received, and the VIES lines. Pure:
// the files (files.ts) and the summary (summary.ts) are written from what this returns.
//
// THE RULES, each from the text (docs/legal/NRA_FILE_FORMATS.md, "What goes where"):
//  - Sales journal: ППЗДДС чл. 113, ал. 2 — a чл. 97а person records "единствено" the documents for
//    services under чл. 21, ал. 2 supplied to another member state, the services received on which
//    it owes the tax under чл. 82, ал. 2, т. 3, and intra-EU acquisitions (it makes none). So a
//    фактура to a Bulgarian customer (чл. 113, ал. 9), to a consumer, or outside the EU is NOT in it;
//    the summary lists each one with the reason.
//  - An EU B2B service sale is recorded with its taxable amount in 02-17 ("услуги по чл. 21, ал. 2 …
//    в друга държава членка"). 02-10 is NOT that amount: Appendix 12 defines 02-10 as the sum of
//    02-11, 02-12, 02-13, 02-14, 02-15, 02-16 and 02-26, which leaves 02-17 out.
//  - A received service is self-charged with a protocol (ЗДДС чл. 117, ал. 1, т. 1), recorded in
//    the sales journal with its base in 02-26 ("ДО по получените доставки по чл. 82, ал. 2 - 5"), its
//    tax in 02-22, and both again in the totals 02-10 and 02-20.
//  - The same protocol in the purchase journal, base PLUS tax in 03-30 ("Данъчна основа и данък на
//    получените доставки … без право на данъчен кредит"): a чл. 97а person has no tax credit
//    (ЗДДС чл. 70, ал. 4).
//  - VIES: one line per customer VAT number, the services in field 6 (Appendix 15), every month
//    with an EU B2B service sale (ЗДДС чл. 125, ал. 2).
//
// Document type codes (Appendix 12, "Вид на документа"): 01 фактура, 03 кредитно известие,
// 09 "Протокол или друг документ".

import type { BalanceRow, MonthWindow } from "@/lib/billing/factura/export";
import type { Factura } from "@/lib/db/schema";
import { parseVatNumber } from "@/lib/early-access/vat-number";
import { eurToCents, type NraInput, type NraSupplier } from "./input";

/** The standard rate, as a percentage (ЗДДС чл. 66, ал. 1, т. 1). */
export const VAT_RATE_PERCENT = 20;

/** Appendix 12: the counterparty identifier of a foreign person with no EU VAT number. */
export const NO_EU_VAT_ID = "999999999999999";

/** The ground printed on each protocol for charging the tax. */
export const PROTOCOL_TAX_GROUND = "чл. 82, ал. 2, т. 3 ЗДДС";

/** The Stripe balance-transaction types that are Stripe's own software fees (Billing, Tax, Radar …). */
export const STRIPE_SOFTWARE_FEE_TYPES: readonly string[] = ["stripe_fee", "tax_fee"];

/** A line of the sales journal. Amounts are euro cents. */
export interface SalesEntry {
	/** "01" фактура, "03" кредитно известие, "09" протокол. */
	docType: "01" | "03" | "09";
	number: string;
	/** YYYY-MM-DD. */
	date: string;
	/** 02-07: the customer's (or, for a protocol, the supplier's) VAT number, or NO_EU_VAT_ID. */
	counterpartyId: string;
	counterpartyName: string;
	description: string;
	/** 02-17: services under чл. 21, ал. 2 to another member state. */
	euServiceBase: number;
	/** 02-26: base of services received under чл. 82, ал. 2. */
	reverseChargeBase: number;
	/** 02-22: tax charged on them. */
	reverseChargeVat: number;
}

/** A line of the purchase journal. Amounts are euro cents. */
export interface PurchaseEntry {
	docType: "09";
	number: string;
	date: string;
	/** 03-08: the supplier's VAT number, or NO_EU_VAT_ID. */
	counterpartyId: string;
	counterpartyName: string;
	description: string;
	/** 03-30: base plus tax, with no tax credit. */
	noCreditBaseAndVat: number;
}

/** A VIES line: one customer VAT number and one period. */
export interface ViesLine {
	/** With its member-state prefix (EL for Greece). */
	vatNumber: string;
	/** The services under чл. 21, ал. 2, euro cents. */
	servicesBase: number;
	/** YYYY-MM the tax became chargeable; the declaration's period when the same. */
	period: string;
}

/** One line of a protocol. */
export interface ProtocolLine {
	description: string;
	/** Euro cents. */
	base: number;
}

/** A чл. 117, ал. 1, т. 1 protocol for one received service (or one Stripe month). */
export interface ReverseChargeProtocol {
	/** Ten digits, zero-padded. */
	number: string;
	issueDate: string;
	/** чл. 117, ал. 2, т. 4: the date of the chargeable event. */
	taxEventDate: string;
	supplier: NraSupplier;
	/** The supplier's invoice, when issued by the protocol date (чл. 117, ал. 2, т. 9). */
	supplierDocument: { number: string; date: string } | null;
	lines: ProtocolLine[];
	base: number;
	vat: number;
}

/** A document of the month that is not in the sales journal, and why. */
export interface ExcludedDocument {
	number: string;
	kind: string;
	recipient: string;
	country: string;
	baseEur: number;
	reason: string;
}

/** Stripe's fees in the month, split by treatment. Euro cents. */
export interface StripeFees {
	/** Billing, Tax, Radar … (`STRIPE_SOFTWARE_FEE_TYPES`): always taxable. */
	software: number;
	/** The card-processing fees taken from charges. */
	processing: number;
	/** The input file's decision on processing; null when there were none to decide. */
	processingTreatment: "taxable" | "exempt" | null;
}

/** The month, ready to be written. */
export interface NraMonth {
	window: MonthWindow;
	filer: NraInput["filer"];
	sales: SalesEntry[];
	purchases: PurchaseEntry[];
	vies: ViesLine[];
	protocols: ReverseChargeProtocol[];
	excluded: ExcludedDocument[];
	stripe: StripeFees;
	/** Things the reviewer should know: a late protocol, a cut name. */
	notes: string[];
}

/** 20 % of `base` cents, rounded half away from zero to the cent. */
export function vatOf(base: number): number {
	const abs = Math.abs(base);
	const vat = Math.floor((abs * VAT_RATE_PERCENT + 50) / 100);
	return base < 0 ? -vat : vat;
}

/** A YYYY-MM-DD plus `days`. */
function addDays(iso: string, days: number): string {
	const d = new Date(`${iso}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
}

/** The document's taxable amount in euro cents: its own for EUR, its Art. 114(5) equivalent otherwise. */
function baseEur(doc: Factura): number | null {
	const s = doc.snapshot;
	if (s.currency === "EUR") return s.taxBaseMinor;
	return s.eurEquivalent ? s.eurEquivalent.taxBaseEurMinor : null;
}

/** The recipient's EU VAT number, normalised with its VIES prefix, when it has one outside Bulgaria. */
function euVatNumber(doc: Factura): string | null {
	for (const id of doc.snapshot.recipient.identifiers) {
		const parsed = parseVatNumber(id.value);
		if (parsed.ok && parsed.vat.country === doc.snapshot.recipient.country) return parsed.vat.normalised;
	}
	return null;
}

/** 02-07/03-08 for a supplier: its EU VAT number, or NO_EU_VAT_ID. Null for a Bulgarian supplier. */
function supplierId(s: NraSupplier): string | null {
	if (!s.vatNumber) return s.country === "BG" ? null : NO_EU_VAT_ID;
	const parsed = parseVatNumber(s.vatNumber);
	if (parsed.ok) return parsed.vat.normalised;
	return parsed.reason === "seller_country" || s.country === "BG" ? null : NO_EU_VAT_ID;
}

/** Stripe's fees in the month from its balance transactions (all must be in EUR). */
export function stripeFees(
	balance: readonly BalanceRow[],
	decision: "taxable" | "exempt" | null,
): { ok: true; fees: StripeFees } | { ok: false; problem: string } {
	let software = 0;
	let processing = 0;
	for (const row of balance) {
		const isSoftware = STRIPE_SOFTWARE_FEE_TYPES.includes(row.type);
		if (!isSoftware && row.fee === 0) continue;
		if (row.currency.toLowerCase() !== "eur") {
			return { ok: false, problem: `Stripe balance transaction ${row.id} is in ${row.currency.toUpperCase()}; only EUR fees can be self-charged without a rate` };
		}
		if (isSoftware) software += -row.amount;
		else processing += row.fee;
	}
	return { ok: true, fees: { software, processing, processingTreatment: processing === 0 ? null : decision } };
}

/** What the month needs beyond the documents and the balance. */
export interface NraMonthInput {
	window: MonthWindow;
	documents: readonly Factura[];
	balance: readonly BalanceRow[];
	operator: NraInput;
}

/**
 * The month's journals, protocols and VIES lines, or the problems that stop them. Refuses rather
 * than guesses: a non-EUR document without its EUR equivalent, Stripe fees with no supplier details,
 * processing fees with no treatment, a purchase outside the month or from a Bulgarian supplier.
 */
export function buildNraMonth(input: NraMonthInput): { ok: true; month: NraMonth } | { ok: false; problems: string[] } {
	const { window, operator } = input;
	const problems: string[] = [];
	const notes: string[] = [];
	const sales: SalesEntry[] = [];
	const excluded: ExcludedDocument[] = [];
	const vies = new Map<string, ViesLine>();

	for (const doc of [...input.documents].sort((a, b) => a.number.localeCompare(b.number))) {
		const s = doc.snapshot;
		const base = baseEur(doc);
		if (base === null) {
			problems.push(`${doc.number}: in ${s.currency} with no EUR equivalent on the document`);
			continue;
		}
		const vat = euVatNumber(doc);
		if (!vat) {
			const country = s.recipient.country;
			excluded.push({
				number: doc.number,
				kind: doc.kind,
				recipient: s.recipient.name,
				country,
				baseEur: base,
				reason:
					country === "BG"
						? "domestic supply by a person not registered under чл. 96 (чл. 113, ал. 9 ЗДДС); not in the journals (ППЗДДС чл. 113, ал. 2)"
						: "not a чл. 21, ал. 2 service to an EU business with a VAT number of its own member state; not in the journals (ППЗДДС чл. 113, ал. 2)",
			});
			continue;
		}
		sales.push({
			docType: doc.kind === "credit_note" ? "03" : "01",
			number: doc.number,
			date: doc.issueDate,
			counterpartyId: vat,
			counterpartyName: s.recipient.name,
			description: s.lines[0]?.description ?? "Услуга",
			euServiceBase: base,
			reverseChargeBase: 0,
			reverseChargeVat: 0,
		});
		const period = doc.chargeableDate.slice(0, 7);
		const key = `${vat}|${period}`;
		const line = vies.get(key) ?? { vatNumber: vat, servicesBase: 0, period };
		line.servicesBase += base;
		vies.set(key, line);
	}

	// A protocol is issued no later than 15 days after the tax became chargeable (ЗДДС чл. 117, ал. 3)
	// and is recorded in the month's journals, so by default each is dated the earlier of those two
	// limits. The input file can fix one date for all of them instead.
	const fixedDate = operator.protocols.issueDate ?? null;
	if (fixedDate && (fixedDate < window.firstDay || fixedDate > window.lastDay)) {
		problems.push(`protocols.issueDate ${fixedDate} is outside ${window.month}`);
	}
	const protocolDateFor = (taxEvent: string): string => {
		if (fixedDate) return fixedDate;
		const limit = addDays(taxEvent, 15);
		return limit < window.lastDay ? limit : window.lastDay;
	};

	// The services received: Stripe's month first, then the listed invoices in date order.
	interface Received {
		supplier: NraSupplier;
		taxEventDate: string;
		document: { number: string; date: string } | null;
		lines: ProtocolLine[];
		/** The journals' 30-character description, when the lines' own text is not it. */
		journalDescription?: string;
	}
	const received: Received[] = [];

	const fees = stripeFees(input.balance, operator.stripe?.processingFees ?? null);
	let stripe: StripeFees = { software: 0, processing: 0, processingTreatment: null };
	if (!fees.ok) problems.push(fees.problem);
	else {
		stripe = fees.fees;
		const lines: ProtocolLine[] = [];
		if (stripe.software !== 0) lines.push({ description: "Stripe: такси за софтуерни услуги (Billing, Tax, Radar)", base: stripe.software });
		if (stripe.processing !== 0 && stripe.processingTreatment === null) {
			problems.push("Stripe processing fees are present: set stripe.processingFees to \"taxable\" or \"exempt\" (the accountant's decision)");
		}
		if (stripe.processingTreatment === "taxable") lines.push({ description: "Stripe: такси за обработка на картови плащания", base: stripe.processing });
		if (lines.length && !operator.stripe) problems.push("Stripe fees are present: add the stripe block (Stripe's legal entity and VAT number)");
		if (lines.length && operator.stripe) {
			const doc = operator.stripe.documentNumber && operator.stripe.documentDate
				? { number: operator.stripe.documentNumber, date: operator.stripe.documentDate }
				: null;
			received.push({
				supplier: operator.stripe.supplier,
				taxEventDate: window.lastDay,
				document: doc,
				lines,
				journalDescription: `Такси Stripe ${window.month}`,
			});
		}
	}

	const purchases = [...operator.purchases].sort(
		(a, b) => a.documentDate.localeCompare(b.documentDate) || a.supplier.name.localeCompare(b.supplier.name) || a.documentNumber.localeCompare(b.documentNumber),
	);
	for (const p of purchases) {
		const event = p.taxEventDate ?? p.documentDate;
		if (event < window.firstDay || event > window.lastDay) {
			problems.push(`purchase ${p.supplier.name} ${p.documentNumber}: tax event ${event} is outside ${window.month}; it belongs to that month's return`);
			continue;
		}
		received.push({
			supplier: p.supplier,
			taxEventDate: event,
			document: { number: p.documentNumber, date: p.documentDate },
			lines: [{ description: p.description, base: eurToCents(p.netEur) }],
		});
	}

	const protocols: ReverseChargeProtocol[] = [];
	const purchaseEntries: PurchaseEntry[] = [];
	for (const r of received) {
		const id = supplierId(r.supplier);
		if (id === null) {
			problems.push(`${r.supplier.name}: a Bulgarian supplier charges its own VAT; there is no reverse charge to self-assess`);
			continue;
		}
		const seq = operator.protocols.firstNumber + protocols.length;
		if (seq > 9_999_999_999) {
			problems.push("the protocol series has passed ten digits");
			break;
		}
		const base = r.lines.reduce((n, l) => n + l.base, 0);
		const vat = vatOf(base);
		const number = String(seq).padStart(10, "0");
		const protocolDate = protocolDateFor(r.taxEventDate);
		protocols.push({ number, issueDate: protocolDate, taxEventDate: r.taxEventDate, supplier: r.supplier, supplierDocument: r.document, lines: r.lines, base, vat });
		if (protocolDate > addDays(r.taxEventDate, 15)) {
			notes.push(`Protocol ${number} (${r.supplier.name}) is dated ${protocolDate}, more than 15 days after the tax event ${r.taxEventDate} (чл. 117, ал. 3 ЗДДС).`);
		}
		const description = r.journalDescription ?? r.lines.map((l) => l.description).join("; ");
		sales.push({
			docType: "09",
			number,
			date: protocolDate,
			counterpartyId: id,
			counterpartyName: r.supplier.name,
			description,
			euServiceBase: 0,
			reverseChargeBase: base,
			reverseChargeVat: vat,
		});
		purchaseEntries.push({
			docType: "09",
			number,
			date: protocolDate,
			counterpartyId: id,
			counterpartyName: r.supplier.name,
			description,
			noCreditBaseAndVat: base + vat,
		});
	}

	if (vies.size && !operator.vies) problems.push("the month has EU B2B sales: add the vies block (declarant and correspondence address)");
	if (problems.length) return { ok: false, problems };

	sales.sort((a, b) => a.date.localeCompare(b.date) || a.docType.localeCompare(b.docType) || a.number.localeCompare(b.number));
	const viesLines = [...vies.values()].sort((a, b) => a.vatNumber.localeCompare(b.vatNumber) || a.period.localeCompare(b.period));
	return {
		ok: true,
		month: { window, filer: operator.filer, sales, purchases: purchaseEntries, vies: viesLines, protocols, excluded, stripe, notes },
	};
}
