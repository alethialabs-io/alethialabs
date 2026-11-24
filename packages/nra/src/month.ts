// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// One month's VAT position of a company registered under чл. 100, ал. 1 ЗДДС (full, voluntary
// registration): which document goes in which journal and which cells, the чл. 117 protocols for
// the services it received, and the VIES lines. Pure: the files (files.ts) and the summary
// (summary.ts) are written from what this returns.
//
// THE RULES (docs/legal/NRA_FILE_FORMATS.md §5 cites each):
//  Sales journal (PRODAGBI), every document the company issued from the effective date:
//   - bg_vat_20: place of supply in Bulgaria, 20 % (чл. 66, ал. 1, т. 1): base 02-11, tax 02-21.
//   - eu_b2b_services_21_2: a service to a business in another member state (чл. 21, ал. 2),
//     tax due by the customer: base 02-17, and a VIES line. 02-17 is outside 02-10 (Appendix 12's
//     formula for 02-10 does not list it).
//   - outside_eu_69_2: a supply with its place outside the EU (the monthly supply to Paddle.com
//     Market Ltd, UK, or Paddle.com Inc., US), which keeps the credit under чл. 69, ал. 2: 02-18.
//     Also outside 02-10.
//   - a credit note ("03") carries negative amounts in the same cells as its фактура.
//   - each чл. 117 protocol ("09"), self-assessed: base 02-26, tax 02-22 (both again in 02-10 and
//     02-20). 02-26 is "ДО по получените доставки по чл. 82, ал. 2 - 5"; 02-12 is the base of
//     intra-EU acquisitions of GOODS, which the company does not make. DEKLAR 01-12 is the sum of
//     both columns, so the return reads the same either way.
//  Purchase journal (POKUPKI):
//   - each protocol again, full credit (чл. 69, ал. 1, т. 2): base 03-31, tax 03-41;
//   - a Bulgarian фактура with VAT and full credit: 03-31 / 03-41; with no credit: 03-30, base
//     plus tax;
//   - outside_journal (an exempt financial service: Stripe's card-processing fee by default): in
//     neither journal, listed in the summary.
//  Before the effective date of the registration (чл. 103, т. 3), a document is in neither journal:
//  the summary lists it.
//
// Document type codes (Appendix 12, "Вид на документа"): 01 фактура, 03 кредитно известие,
// 09 "Протокол или друг документ".

import {
	type NraInput,
	type NraPurchase,
	type NraSupplier,
	type ProtocolRequest,
	type SalesDocument,
	type SalesFile,
	toCents,
} from "./input";
import { centsToDecimal } from "./record";
import { euVatNumberOf, isEuCountry, NO_EU_VAT_ID } from "./vat-number";

/** The standard rate, as a percentage (ЗДДС чл. 66, ал. 1, т. 1). */
export const VAT_RATE_PERCENT = 20;

/** The ground printed on each protocol for charging the tax. */
export const PROTOCOL_TAX_GROUND = "чл. 82, ал. 2, т. 3 ЗДДС";

/** The ground of the credit on a protocol. */
export const PROTOCOL_CREDIT_GROUND = "чл. 69, ал. 1, т. 2 ЗДДС";

/** The days of a month. */
export interface MonthWindow {
	/** YYYY-MM. */
	month: string;
	/** YYYY-MM-DD. */
	firstDay: string;
	/** YYYY-MM-DD. */
	lastDay: string;
}

/** The window of `month` (YYYY-MM). */
export function monthWindow(month: string): MonthWindow {
	const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
	if (!m) throw new Error(`"${month}" is not a month (YYYY-MM)`);
	const y = Number(m[1]);
	const mo = Number(m[2]);
	const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
	return { month, firstDay: `${month}-01`, lastDay: `${month}-${String(last).padStart(2, "0")}` };
}

/** A sales-journal amount cell. */
export type SalesCell = "02-11" | "02-21" | "02-12" | "02-26" | "02-22" | "02-17" | "02-18";
/** A purchase-journal amount cell. */
export type PurchaseCell = "03-30" | "03-31" | "03-41";

/** A line of the sales journal. Amounts are euro cents. */
export interface SalesEntry {
	/** "01" фактура, "03" кредитно известие, "09" протокол. */
	docType: "01" | "03" | "09";
	number: string;
	/** YYYY-MM-DD. */
	date: string;
	/** 02-07: the counterparty's VAT number, ЕИК, or NO_EU_VAT_ID. */
	counterpartyId: string;
	counterpartyName: string;
	description: string;
	/** The cells it fills; any other amount cell is 0.00. */
	cells: Partial<Record<SalesCell, number>>;
}

/** A line of the purchase journal. Amounts are euro cents. */
export interface PurchaseEntry {
	docType: "01" | "03" | "09";
	number: string;
	date: string;
	/** 03-08: the supplier's VAT number, or NO_EU_VAT_ID. */
	counterpartyId: string;
	counterpartyName: string;
	description: string;
	cells: Partial<Record<PurchaseCell, number>>;
}

/** A VIES line: one customer VAT number and one period. */
export interface ViesLine {
	/** With its member-state prefix (EL for Greece). */
	vatNumber: string;
	/** The services under чл. 21, ал. 2, euro cents. */
	servicesBase: number;
	/** YYYY-MM the tax became chargeable. */
	period: string;
}

/** One line of a protocol. */
export interface ProtocolLine {
	description: string;
	/** Euro cents. */
	base: number;
}

/** A чл. 117, ал. 1, т. 1 protocol for one received service. */
export interface ReverseChargeProtocol {
	/** Ten digits, zero-padded. */
	number: string;
	issueDate: string;
	/** чл. 117, ал. 2, т. 4: the date of the chargeable event. */
	taxEventDate: string;
	supplier: NraSupplier;
	/** The supplier's invoice (чл. 117, ал. 2, т. 9). */
	supplierDocument: { number: string; date: string };
	/** The invoice's own currency and the rate used, when not EUR. */
	conversion: { currency: string; amount: string; eurRate: string } | null;
	lines: ProtocolLine[];
	base: number;
	vat: number;
}

/** A document of the month in neither journal, and why. */
export interface UnrecordedDocument {
	/** Issued by the company, or received. */
	side: "issued" | "received";
	number: string;
	date: string;
	counterparty: string;
	country: string;
	/** Euro cents. */
	netEur: number;
	reason: string;
}

/** The month, ready to be written. */
export interface NraMonth {
	window: MonthWindow;
	filer: NraInput["filer"];
	registration: NraInput["registration"];
	sales: SalesEntry[];
	purchases: PurchaseEntry[];
	vies: ViesLine[];
	protocols: ReverseChargeProtocol[];
	unrecorded: UnrecordedDocument[];
	/** 01-70's input: earlier refundable VAT set off this period, euro cents. */
	refundOffset: number;
	/** Things the reviewer should know: a late protocol, a rounding cent. */
	notes: string[];
}

/** `pct` % of `base` cents, rounded half away from zero to the cent. */
export function percentOf(base: number, pct: number): number {
	const abs = Math.abs(base);
	const v = Math.floor((abs * pct + 50) / 100);
	return base < 0 ? -v : v;
}

/** 20 % of `base` cents. */
export function vatOf(base: number): number {
	return percentOf(base, VAT_RATE_PERCENT);
}

/** A YYYY-MM-DD plus `days`. */
export function addDays(iso: string, days: number): string {
	const d = new Date(`${iso}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
}

/** True for a real calendar date. */
function isDate(iso: string): boolean {
	const d = new Date(`${iso}T00:00:00Z`);
	return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso;
}

/** `amount` (a decimal in its currency) × `rate` (EUR per unit), in euro cents, half away from zero. */
export function convertToEurCents(amount: string, rate: string): number {
	const cents = BigInt(toCents(amount));
	const [whole = "0", frac = ""] = rate.split(".");
	const scaled = BigInt(whole + frac.padEnd(8, "0"));
	const product = cents * scaled;
	const neg = product < BigInt(0);
	const abs = neg ? -product : product;
	const rounded = (abs + BigInt(50_000_000)) / BigInt(100_000_000);
	return Number(neg ? -rounded : rounded);
}

/** The money fields every document carries. */
interface Money {
	currency: string;
	amount: string;
	eurRate: string | null;
	netEur: string;
}

/** Problems with a document's currency, rate and EUR amount; a one-cent conversion gap is a note. */
function checkMoney(m: Money, where: string, problems: string[], notes: string[]): void {
	const net = toCents(m.netEur);
	if (m.currency === "EUR") {
		if (m.eurRate !== null && m.eurRate.replace(/\.?0+$/, "") !== "1") problems.push(`${where}: in EUR with a rate ${m.eurRate}; give eurRate null`);
		if (toCents(m.amount) !== net) problems.push(`${where}: in EUR, but amount ${m.amount} and netEur ${m.netEur} differ`);
		return;
	}
	if (m.eurRate === null) {
		problems.push(`${where}: in ${m.currency} with no eurRate`);
		return;
	}
	const expected = convertToEurCents(m.amount, m.eurRate);
	const gap = Math.abs(expected - net);
	if (gap > 1) problems.push(`${where}: ${m.currency} ${m.amount} × ${m.eurRate} is EUR ${centsToDecimal(expected)}, not netEur ${m.netEur}`);
	else if (gap === 1) notes.push(`${where}: netEur ${m.netEur} is one cent from ${m.currency} ${m.amount} × ${m.eurRate}; kept as given.`);
}

/** A document's sign rule: a фактура is ≥ 0, a credit note ≤ 0. */
function checkSign(kind: "invoice" | "credit_note", cents: number[], where: string, problems: string[]): void {
	const bad = kind === "invoice" ? cents.some((c) => c < 0) : cents.some((c) => c > 0);
	if (bad) problems.push(`${where}: a ${kind === "invoice" ? "фактура has negative" : "credit note has positive"} amounts`);
}

/** 03-08 / 02-07 for a supplier of a reverse-charge service: its EU VAT number, or NO_EU_VAT_ID. */
function foreignSupplierId(s: NraSupplier): string {
	if (!s.vatNumber || !isEuCountry(s.country)) return NO_EU_VAT_ID;
	return euVatNumberOf(s.vatNumber, s.country) ?? NO_EU_VAT_ID;
}

/** 02-07 for a domestic recipient: its BG VAT number, else its ЕИК/ЕГН, else NO_EU_VAT_ID. */
function domesticRecipientId(d: SalesDocument): string {
	const vat = d.recipient.vatNumber ? euVatNumberOf(d.recipient.vatNumber, "BG") : null;
	return vat ?? d.recipient.localId ?? NO_EU_VAT_ID;
}

/**
 * One protocol issued on its own (`nra:protocol`, the books workflow's daily run): `request`'s
 * purchase under `number`, dated `issueDate` (default: the earlier of `today` and the tax event plus
 * 15 days). The same checks as in a month's build; the month's build later takes the number and
 * date from the purchase's protocolNumber / protocolDate.
 */
export function buildSingleProtocol(
	request: ProtocolRequest,
	number: string,
	today: string,
): { ok: true; protocol: ReverseChargeProtocol; notes: string[] } | { ok: false; problems: string[] } {
	const p = request.purchase;
	const where = `purchase ${p.supplier.name} ${p.documentNumber}`;
	const problems: string[] = [];
	const notes: string[] = [];
	if (!/^\d{1,10}$/.test(number) || /^0+$/.test(number)) problems.push(`--number ${number}: a protocol number is 1 to 10 digits, not all zeros`);
	if (p.treatment !== "rc_services_82_2") problems.push(`${where}: only an rc_services_82_2 purchase gets a чл. 117 protocol, not ${p.treatment}`);
	if (p.supplier.country === "BG") problems.push(`${where}: a Bulgarian supplier charges its own VAT; there is no reverse charge to self-assess`);
	if (p.kind === "credit_note") problems.push(`${where}: a correcting protocol for a credit note is issued by hand`);
	checkMoney(p, where, problems, notes);
	const net = toCents(p.netEur);
	checkSign(p.kind, [net], where, problems);
	const vat = vatOf(net);
	if (p.vatEur !== undefined && toCents(p.vatEur) !== vat) problems.push(`${where}: vatEur ${p.vatEur} is not 20 % of ${p.netEur}`);
	const limit = addDays(p.taxEventDate, 15);
	const issueDate = request.issueDate ?? (limit < today ? limit : today);
	if (!isDate(issueDate) || !isDate(p.taxEventDate)) problems.push(`${where}: a date is not a calendar date`);
	if (issueDate < p.taxEventDate) problems.push(`${where}: protocol date ${issueDate} is before the tax event ${p.taxEventDate}`);
	if (issueDate > limit) notes.push(`Protocol dated ${issueDate}, more than 15 days after the tax event ${p.taxEventDate} (чл. 117, ал. 3 ЗДДС).`);
	if (problems.length) return { ok: false, problems };
	return {
		ok: true,
		notes,
		protocol: {
			number: number.padStart(10, "0"),
			issueDate,
			taxEventDate: p.taxEventDate,
			supplier: p.supplier,
			supplierDocument: { number: p.documentNumber, date: p.documentDate },
			conversion: p.currency === "EUR" || p.eurRate === null ? null : { currency: p.currency, amount: p.amount, eurRate: p.eurRate },
			lines: [{ description: p.description, base: net }],
			base: net,
			vat,
		},
	};
}

/** What the month is built from. */
export interface NraMonthInput {
	sales: SalesFile;
	input: NraInput;
}

/** The result of building a month. */
export type NraMonthResult = { ok: true; month: NraMonth } | { ok: false; problems: string[] };

/**
 * The month's journals, protocols and VIES lines, or every problem that stops them. Refuses rather
 * than guesses: a document outside the month, an amount that does not convert, a VAT figure that is
 * not 20 %, a treatment that contradicts the counterparty's country, a protocol with no number.
 */
export function buildNraMonth({ sales: file, input }: NraMonthInput): NraMonthResult {
	const window = monthWindow(file.month);
	const effective = input.registration.effectiveDate;
	const problems: string[] = [];
	const notes: string[] = [];
	const sales: SalesEntry[] = [];
	const purchases: PurchaseEntry[] = [];
	const unrecorded: UnrecordedDocument[] = [];
	const vies = new Map<string, ViesLine>();

	if (!isDate(effective)) problems.push(`registration.effectiveDate ${effective} is not a date`);
	if (effective > window.lastDay) {
		return { ok: false, problems: [`the registration is effective from ${effective}, after ${window.month}: there is no return for this month`] };
	}

	// ---- documents issued ----
	const seen = new Set<string>();
	for (const d of [...file.documents].sort((a, b) => a.number.localeCompare(b.number))) {
		const where = `${d.kind === "credit_note" ? "credit note" : "фактура"} ${d.number}`;
		if (seen.has(d.number)) problems.push(`${where}: listed twice`);
		seen.add(d.number);
		if (d.issueDate < window.firstDay || d.issueDate > window.lastDay) {
			problems.push(`${where}: issued ${d.issueDate}, outside ${window.month}`);
			continue;
		}
		checkMoney(d, where, problems, notes);
		const net = toCents(d.netEur);
		const vat = toCents(d.vatEur);
		checkSign(d.kind, [net, vat], where, problems);
		if (d.chargeableDate < effective) {
			unrecorded.push({
				side: "issued",
				number: d.number,
				date: d.issueDate,
				counterparty: d.recipient.name,
				country: d.recipient.country,
				netEur: net,
				reason: `tax event ${d.chargeableDate} before the registration took effect (${effective}); not in the journals`,
			});
			continue;
		}
		const base = { docType: d.kind === "credit_note" ? ("03" as const) : ("01" as const), number: d.number, date: d.issueDate, counterpartyName: d.recipient.name, description: d.description };
		switch (d.treatment) {
			case "bg_vat_20": {
				const expected = vatOf(net);
				if (Math.abs(expected - vat) > 1) problems.push(`${where}: VAT EUR ${d.vatEur} is not 20 % of ${d.netEur} (EUR ${centsToDecimal(expected)})`);
				else if (expected !== vat) notes.push(`${where}: VAT EUR ${d.vatEur} is one cent from 20 % of ${d.netEur}; kept as on the document.`);
				sales.push({ ...base, counterpartyId: domesticRecipientId(d), cells: { "02-11": net, "02-21": vat } });
				break;
			}
			case "eu_b2b_services_21_2": {
				const id = d.recipient.vatNumber ? euVatNumberOf(d.recipient.vatNumber, d.recipient.country) : null;
				if (d.recipient.country === "BG" || !id) {
					problems.push(`${where}: eu_b2b_services_21_2 needs a recipient in another member state with a VAT number of that state`);
					break;
				}
				if (vat !== 0) problems.push(`${where}: a чл. 21, ал. 2 service carries no Bulgarian VAT`);
				sales.push({ ...base, counterpartyId: id, cells: { "02-17": net } });
				const period = d.chargeableDate.slice(0, 7);
				const key = `${id}|${period}`;
				const line = vies.get(key) ?? { vatNumber: id, servicesBase: 0, period };
				line.servicesBase += net;
				vies.set(key, line);
				break;
			}
			case "outside_eu_69_2": {
				if (isEuCountry(d.recipient.country)) {
					problems.push(`${where}: outside_eu_69_2 needs a recipient outside the EU, not ${d.recipient.country}`);
					break;
				}
				if (vat !== 0) problems.push(`${where}: a supply outside the EU carries no Bulgarian VAT`);
				sales.push({ ...base, counterpartyId: NO_EU_VAT_ID, cells: { "02-18": net } });
				break;
			}
		}
	}

	// ---- documents received ----
	// A protocol is issued no later than 15 days after the tax became chargeable (чл. 117, ал. 3) and
	// is recorded in that month's journals, so by default it is dated the earlier of those two limits.
	const fixedDate = input.protocols.issueDate ?? null;
	if (fixedDate && (fixedDate < window.firstDay || fixedDate > window.lastDay)) problems.push(`protocols.issueDate ${fixedDate} is outside ${window.month}`);
	const protocolDateFor = (p: NraPurchase): string => {
		if (p.protocolDate) return p.protocolDate;
		if (fixedDate) return fixedDate;
		const limit = addDays(p.taxEventDate, 15);
		return limit < window.lastDay ? limit : window.lastDay;
	};

	const received = [...input.purchases].sort(
		(a, b) => a.taxEventDate.localeCompare(b.taxEventDate) || a.supplier.name.localeCompare(b.supplier.name) || a.documentNumber.localeCompare(b.documentNumber),
	);
	const protocols: ReverseChargeProtocol[] = [];
	const numbers = new Set<string>();
	let next = input.protocols.firstNumber ?? null;
	for (const p of received) {
		const where = `purchase ${p.supplier.name} ${p.documentNumber}`;
		if (p.taxEventDate < window.firstDay || p.taxEventDate > window.lastDay) {
			problems.push(`${where}: tax event ${p.taxEventDate} is outside ${window.month}; it belongs to that month's return`);
			continue;
		}
		checkMoney(p, where, problems, notes);
		const net = toCents(p.netEur);
		const vat = p.vatEur === undefined ? null : toCents(p.vatEur);
		checkSign(p.kind, [net, vat ?? 0], where, problems);
		const docType = p.kind === "credit_note" ? ("03" as const) : ("01" as const);
		const unrecordedRow = (reason: string): UnrecordedDocument => ({
			side: "received",
			number: p.documentNumber,
			date: p.documentDate,
			counterparty: p.supplier.name,
			country: p.supplier.country,
			netEur: net,
			reason,
		});
		if (p.taxEventDate < effective) {
			unrecorded.push(unrecordedRow(`tax event before the registration took effect (${effective}); no credit in this return (чл. 74 ЗДДС is a question for the accountant)`));
			continue;
		}
		switch (p.treatment) {
			case "outside_journal":
				unrecorded.push(unrecordedRow("treated as outside the journals (an exempt or out-of-scope supply received)"));
				break;
			case "bg_vat_full_credit":
			case "bg_vat_no_credit": {
				if (p.supplier.country !== "BG") {
					problems.push(`${where}: ${p.treatment} is for a Bulgarian supplier; a foreign service is rc_services_82_2`);
					break;
				}
				if (vat === null) {
					problems.push(`${where}: ${p.treatment} needs vatEur (the VAT on the supplier's фактура)`);
					break;
				}
				const id = p.supplier.vatNumber ? euVatNumberOf(p.supplier.vatNumber, "BG") : null;
				if (p.treatment === "bg_vat_full_credit" && !id) {
					problems.push(`${where}: a credit needs the supplier's BG VAT number as on its фактура (чл. 71, т. 1 ЗДДС)`);
					break;
				}
				const entry = { docType, number: p.documentNumber, date: p.documentDate, counterpartyId: id ?? NO_EU_VAT_ID, counterpartyName: p.supplier.name, description: p.description };
				purchases.push(
					p.treatment === "bg_vat_full_credit"
						? { ...entry, cells: { "03-31": net, "03-41": vat } }
						: { ...entry, cells: { "03-30": net + vat } },
				);
				break;
			}
			case "rc_services_82_2": {
				if (p.supplier.country === "BG") {
					problems.push(`${where}: a Bulgarian supplier charges its own VAT; there is no reverse charge to self-assess`);
					break;
				}
				if (p.kind === "credit_note") {
					problems.push(`${where}: a supplier's credit note on a reverse-charge service needs a correcting protocol; issue it by hand`);
					break;
				}
				const tax = vatOf(net);
				if (vat !== null && vat !== tax) {
					problems.push(`${where}: vatEur ${p.vatEur} is not 20 % of ${p.netEur}`);
					break;
				}
				let number: string;
				if (p.protocolNumber) number = p.protocolNumber.padStart(10, "0");
				else if (input.protocols.series === "shared_with_factura") {
					problems.push(`${where}: the protocols share the фактура series, so its protocolNumber must be given`);
					break;
				} else if (next === null) {
					problems.push(`${where}: no protocolNumber and no protocols.firstNumber to number it from`);
					break;
				} else {
					while (numbers.has(String(next).padStart(10, "0"))) next++;
					if (next > 9_999_999_999) {
						problems.push("the protocol series has passed ten digits");
						break;
					}
					number = String(next).padStart(10, "0");
					next++;
				}
				if (numbers.has(number)) {
					problems.push(`${where}: protocol number ${number} is used twice`);
					break;
				}
				numbers.add(number);
				const issueDate = protocolDateFor(p);
				if (!isDate(issueDate) || issueDate < p.taxEventDate) problems.push(`${where}: protocol date ${issueDate} is before the tax event ${p.taxEventDate}`);
				if (issueDate > window.lastDay || issueDate < window.firstDay) problems.push(`${where}: protocol date ${issueDate} is outside ${window.month}`);
				if (issueDate > addDays(p.taxEventDate, 15)) notes.push(`Protocol ${number} (${p.supplier.name}) is dated ${issueDate}, more than 15 days after the tax event ${p.taxEventDate} (чл. 117, ал. 3 ЗДДС).`);
				const id = foreignSupplierId(p.supplier);
				protocols.push({
					number,
					issueDate,
					taxEventDate: p.taxEventDate,
					supplier: p.supplier,
					supplierDocument: { number: p.documentNumber, date: p.documentDate },
					conversion: p.currency === "EUR" || p.eurRate === null ? null : { currency: p.currency, amount: p.amount, eurRate: p.eurRate },
					lines: [{ description: p.description, base: net }],
					base: net,
					vat: tax,
				});
				const entry = { docType: "09" as const, number, date: issueDate, counterpartyId: id, counterpartyName: p.supplier.name, description: p.description };
				sales.push({ ...entry, cells: { "02-26": net, "02-22": tax } });
				purchases.push({ ...entry, cells: { "03-31": net, "03-41": tax } });
				break;
			}
		}
	}

	if (vies.size && !input.vies) problems.push("the month has EU B2B sales: add the vies block (declarant and correspondence address)");
	const refundOffset = input.deklar?.refundOffsetEur ? toCents(input.deklar.refundOffsetEur) : 0;
	if (refundOffset < 0) problems.push("deklar.refundOffsetEur cannot be negative");
	if (problems.length) return { ok: false, problems };

	const order = <T extends { date: string; docType: string; number: string }>(a: T, b: T) =>
		a.date.localeCompare(b.date) || a.docType.localeCompare(b.docType) || a.number.localeCompare(b.number);
	sales.sort(order);
	purchases.sort(order);
	protocols.sort((a, b) => a.number.localeCompare(b.number));
	const viesLines = [...vies.values()].sort((a, b) => a.vatNumber.localeCompare(b.vatNumber) || a.period.localeCompare(b.period));
	return {
		ok: true,
		month: { window, filer: input.filer, registration: input.registration, sales, purchases, vies: viesLines, protocols, unrecorded, refundOffset, notes },
	};
}
