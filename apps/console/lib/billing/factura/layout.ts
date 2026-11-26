// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Every string printed on a фактура, in reading order, computed from its snapshot (#7368). The PDF
// component (document.tsx) lays these out and prints nothing else, so the golden test of this
// model is a test of the document's text. Labels are Bulgarian first, English second: the document
// is Bulgarian (Art. 114 ЗДДС), and most recipients read English.

import { formatMoney } from "@repo/format";
import type { FacturaParty, FacturaSnapshot } from "@/types/jsonb.types";

/** A labelled value, e.g. the issue date. */
export interface LayoutPair {
	label: string;
	value: string;
}

/** One party block on the document. */
interface LayoutParty {
	heading: string;
	lines: string[];
}

/** The printed content of one фактура. */
export interface FacturaLayout {
	title: string;
	number: string;
	dates: LayoutPair[];
	supplier: LayoutParty;
	recipient: LayoutParty;
	table: { header: string[]; rows: string[][] };
	totals: LayoutPair[];
	/** The Art. 114(5) block; null for an EUR document. */
	eur: { totals: LayoutPair[]; rate: string } | null;
	notes: string[];
}

/** YYYY-MM-DD → DD.MM.YYYY, the Bulgarian date form. */
function bgDate(iso: string): string {
	const [y, m, d] = iso.split("-");
	return `${d}.${m}.${y}`;
}

/** An amount in `currency`'s minor unit, through the console's one money formatter. */
function amount(minor: number, currency: string): string {
	return formatMoney(minor, currency);
}

const BG_REGION = new Intl.DisplayNames(["bg"], { type: "region" });
const EN_REGION = new Intl.DisplayNames(["en"], { type: "region" });

/** A country as "Bulgarian / English", e.g. "Германия / Germany"; the code itself if unknown. */
function countryName(code: string): string {
	try {
		const bg = BG_REGION.of(code);
		const en = EN_REGION.of(code);
		return bg && en && bg !== code ? `${bg} / ${en}` : code;
	} catch {
		return code;
	}
}

/** The lines of one party block. */
function partyLines(p: FacturaParty): string[] {
	return [
		p.name,
		...p.addressLines,
		countryName(p.country),
		...p.identifiers.map((i) => `${i.label}: ${i.value}`),
	];
}

/** The description cell of a line, with its service period when it has one. */
function describe(description: string, start: string | null, end: string | null): string {
	return start && end ? `${description} (${bgDate(start)} – ${bgDate(end)})` : description;
}

/** The VAT total's label, with the rate when VAT is charged (Art. 114(1), point 11). */
function vatLabel(ratePercent: number | null | undefined): string {
	return ratePercent ? `ДДС ${ratePercent}% / VAT ${ratePercent}%` : "ДДС / VAT";
}

/**
 * How the document is settled. A Stripe document (and every row written before L6b, which has no
 * `source`) was paid or refunded through Stripe; a manual one is settled by bank transfer — the
 * Paddle payout, an Enterprise customer's transfer.
 */
function paymentNote(s: FacturaSnapshot): string {
	if (s.source === "manual") {
		return s.original ? "Уреждане по банков път / Settled by bank transfer" : "Плащане по банков път / Payment by bank transfer";
	}
	return s.original ? "Възстановено чрез Stripe / Refunded via Stripe" : "Платено чрез Stripe / Paid via Stripe";
}

/** The printed content of the фактура or credit note `s` (a credit note has `original` set). */
export function facturaLayout(s: FacturaSnapshot): FacturaLayout {
	const eur = s.eurEquivalent;
	return {
		title: `${s.documentName} / ${s.original ? "Credit note" : "Invoice"}`,
		number: `№ ${s.number}`,
		dates: [
			{ label: "Дата на издаване / Date of issue", value: bgDate(s.issueDate) },
			{ label: "Дата на данъчното събитие / Chargeable date", value: bgDate(s.chargeableDate) },
			...(s.original
				? [{ label: "Към фактура / Corrects invoice", value: `№ ${s.original.number} от ${bgDate(s.original.issueDate)}` }]
				: []),
		],
		supplier: { heading: "Доставчик / Supplier", lines: partyLines(s.supplier) },
		recipient: { heading: "Получател / Recipient", lines: partyLines(s.recipient) },
		table: {
			header: ["№", "Вид на услугата / Service", "Кол. / Qty", "Ед. цена / Unit price", "Стойност / Amount"],
			rows: s.lines.map((l, i) => [
				String(i + 1),
				describe(l.description, l.periodStart, l.periodEnd),
				String(l.quantity),
				amount(l.unitAmountMinor, s.currency),
				amount(l.amountMinor, s.currency),
			]),
		},
		totals: [
			{ label: "Данъчна основа / Taxable amount", value: amount(s.taxBaseMinor, s.currency) },
			{ label: vatLabel(s.vatRatePercent), value: amount(s.vatMinor, s.currency) },
			{
				label: s.original ? "Сума за възстановяване / Amount refunded" : "Сума за плащане / Amount payable",
				value: amount(s.totalMinor, s.currency),
			},
		],
		eur: eur
			? {
					totals: [
						{ label: "Данъчна основа в EUR / Taxable amount in EUR", value: amount(eur.taxBaseEurMinor, "EUR") },
						{ label: "ДДС в EUR / VAT in EUR", value: amount(eur.vatEurMinor, "EUR") },
					],
					rate: `Курс / Rate: 1 ${s.currency} = ${eur.rate} EUR (${eur.source.split(":")[0]}, ${bgDate(eur.rateDate)})`,
				}
			: null,
		notes: [
			...(s.reason ? [`Основание за издаване / Reason for issue: ${s.reason}`] : []),
			...(s.noVatGround ? [`Основание за неначисляване на ДДС / Ground for not charging VAT: ${s.noVatGround}`] : []),
			paymentNote(s),
			...(s.stripeInvoiceNumber ? [`Референция / Reference: ${s.stripeInvoiceNumber}`] : []),
			...(s.reference ? [`Референция / Reference: ${s.reference}`] : []),
		],
	};
}

/** The layout as plain text, one printed string per line: the golden-test form. */
export function layoutText(l: FacturaLayout): string {
	const pairs = (ps: LayoutPair[]) => ps.map((p) => `${p.label}: ${p.value}`);
	return [
		l.title,
		l.number,
		...pairs(l.dates),
		l.supplier.heading,
		...l.supplier.lines,
		l.recipient.heading,
		...l.recipient.lines,
		l.table.header.join(" | "),
		...l.table.rows.map((r) => r.join(" | ")),
		...pairs(l.totals),
		...(l.eur ? [...pairs(l.eur.totals), l.eur.rate] : []),
		...l.notes,
	].join("\n");
}
