// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Every string printed on a чл. 117 protocol, in reading order (#7457). The PDF component
// (protocol-document.tsx) prints these and nothing else, so the golden test of this layout is a test
// of the document's text, as for the фактура (lib/billing/factura/layout.ts).
//
// ЗДДС чл. 117, ал. 2 says what a protocol must contain; each point is printed:
//  1. its number and date;
//  2. the name and VAT number (чл. 94, ал. 2) of the person issuing it, the recipient of the service;
//  3. the kind of service;
//  4. the date of the chargeable event;
//  5. the taxable amount;   6. the rate;   7. the ground for charging the tax;   8. the tax;
//  9. the supplier's VAT number when it is VAT-registered in another member state, and the number
//     and date of its invoice when one was issued by the protocol's date.

import { formatMoney } from "@repo/format";
import { LEGAL_ENTITY } from "@repo/legal/entity";
import { FILER_NAME } from "./files";
import { PROTOCOL_TAX_GROUND, type ReverseChargeProtocol, VAT_RATE_PERCENT } from "./month";

/** A labelled value. */
export interface ProtocolPair {
	label: string;
	value: string;
}

/** The printed content of one protocol. */
export interface ProtocolLayout {
	title: string;
	subtitle: string;
	number: string;
	dates: ProtocolPair[];
	issuer: { heading: string; lines: string[] };
	supplier: { heading: string; lines: string[] };
	table: { header: string[]; rows: string[][] };
	totals: ProtocolPair[];
	notes: string[];
}

/** YYYY-MM-DD → DD.MM.YYYY. */
function bgDate(iso: string): string {
	const [y, m, d] = iso.split("-");
	return `${d}.${m}.${y}`;
}

/** Euro cents through the console's one money formatter. */
function eur(cents: number): string {
	return formatMoney(cents, "EUR");
}

/** The printed content of protocol `p`, issued by the company under VAT number `filerVat`. */
export function protocolLayout(p: ReverseChargeProtocol, filerVat: string): ProtocolLayout {
	const doc = p.supplierDocument;
	return {
		title: "ПРОТОКОЛ",
		subtitle: "по чл. 117, ал. 1, т. 1 ЗДДС / Self-assessment protocol (reverse charge)",
		number: `№ ${p.number}`,
		dates: [
			{ label: "Дата на издаване / Date of issue", value: bgDate(p.issueDate) },
			{ label: "Дата на данъчното събитие / Chargeable event", value: bgDate(p.taxEventDate) },
		],
		issuer: {
			heading: "Издател, получател по доставката / Issuer, recipient of the service",
			lines: [FILER_NAME, LEGAL_ENTITY.registeredAddressBulgarian, `ДДС № / VAT No.: ${filerVat}`],
		},
		supplier: {
			heading: "Доставчик / Supplier",
			lines: [
				p.supplier.name,
				`Държава / Country: ${p.supplier.country}`,
				p.supplier.vatNumber ? `ДДС № / VAT No.: ${p.supplier.vatNumber}` : "Без ДДС номер в ЕС / No EU VAT number",
				doc ? `Фактура / Invoice: № ${doc.number} от ${bgDate(doc.date)}` : "Фактура / Invoice: не е издадена към датата на протокола / not issued by the protocol date",
			],
		},
		table: {
			header: ["№", "Вид на услугата / Service", "Данъчна основа / Taxable amount"],
			rows: p.lines.map((l, i) => [String(i + 1), l.description, eur(l.base)]),
		},
		totals: [
			{ label: "Данъчна основа / Taxable amount", value: eur(p.base) },
			{ label: "Ставка / Rate", value: `${VAT_RATE_PERCENT} %` },
			{ label: "ДДС / VAT", value: eur(p.vat) },
		],
		notes: [
			`Основание за начисляване / Ground: ${PROTOCOL_TAX_GROUND}; място на изпълнение в страната (чл. 21, ал. 2 ЗДДС).`,
			"Без право на данъчен кредит (чл. 70, ал. 4 ЗДДС) / No input tax credit (Art. 70(4)).",
		],
	};
}

/** The layout as plain text, one printed string per line: the golden-test form and the .txt copy. */
export function protocolText(l: ProtocolLayout): string {
	const pairs = (ps: ProtocolPair[]) => ps.map((p) => `${p.label}: ${p.value}`);
	return [
		l.title,
		l.subtitle,
		l.number,
		...pairs(l.dates),
		l.issuer.heading,
		...l.issuer.lines,
		l.supplier.heading,
		...l.supplier.lines,
		l.table.header.join(" | "),
		...l.table.rows.map((r) => r.join(" | ")),
		...pairs(l.totals),
		...l.notes,
	].join("\n");
}
