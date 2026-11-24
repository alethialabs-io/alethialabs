// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// SUMMARY.md: what the person who files reads first. It states what to check, every DEKLAR cell
// with its value, each journal line with its cells, the VIES lines, the documents left out and why,
// the VAT payable or refundable with its due date, and the questions the generator cannot answer.
// Pure and deterministic, like the files it describes.

import type { DeklarCells } from "./files";
import { salesAmounts } from "./files";
import { DEKLAR_FIELDS } from "./layout";
import type { NraMonth } from "./month";
import { centsToDecimal } from "./record";

/** The due date of the return and the payment: the 14th of the next month (ЗДДС чл. 125, ал. 5; чл. 89, ал. 1). */
export function dueDate(month: string): string {
	const [y, m] = month.split("-").map(Number);
	const next = (m ?? 1) === 12 ? `${(y ?? 0) + 1}-01` : `${y}-${String((m ?? 1) + 1).padStart(2, "0")}`;
	return `${next}-14`;
}

/** YYYY-MM-DD → DD.MM.YYYY. */
function bgDate(iso: string): string {
	const [y, m, d] = iso.split("-");
	return `${d}.${m}.${y}`;
}

/** A Markdown table cell: no pipes or line breaks. */
function cell(s: string): string {
	return s.replace(/\|/g, "/").replace(/\s+/g, " ");
}

/** The non-zero cells of a journal line, as "02-11 49.00, 02-21 9.80". */
function cellList(cells: ReadonlyMap<string, number> | Readonly<Record<string, number | undefined>>): string {
	const entries = cells instanceof Map ? [...cells.entries()] : Object.entries(cells);
	return entries
		.filter((e): e is [string, number] => typeof e[1] === "number" && e[1] !== 0)
		.sort((a, b) => a[0].localeCompare(b[0]))
		.map(([code, v]) => `${code} ${centsToDecimal(v)}`)
		.join(", ");
}

/** What the summary is written from. */
export interface SummaryInput {
	month: NraMonth;
	cells: DeklarCells;
	textNotes: readonly string[];
	/** The NRA file names written, for the checklist. */
	files: readonly string[];
	/** True for a demo run: the summary says so on its first line. */
	demo: boolean;
}

/** The questions only the accountant can answer; repeated every month until answered in code. */
export const ACCOUNTANT_QUESTIONS: readonly string[] = [
	"Paddle: the monthly фактура to Paddle.com Market Ltd (UK) / Paddle.com Inc. (US) is recorded in 02-18 (чл. 69, ал. 2) with 02-07 = 999999999999999. Right cell, and is that the counterparty code you want (rather than their own UK/US numbers)?",
	"Stripe's card-processing fee (and other exempt financial services received): left out of both journals (the default here), or recorded in 03-30 as a supply received „без данък“?",
	"Protocols: are the чл. 117 protocols recorded in 02-26 / 02-22 (services received under чл. 82, ал. 2) and in 03-31 / 03-41 with full credit (чл. 69, ал. 1, т. 2), each protocol in its own ten-digit series? Or must they share the фактура series?",
	"DEKLAR: 01-33 = 0.00 and 01-42 = 01-43 = 0 (no exempt supplies, so no partial credit); 01-80 = 01-60 when the month is refundable (set-off under чл. 92, ал. 1); 01-70 = earlier refundable VAT set off this month, from the input file. Correct?",
	"A domestic customer with no VAT number: 02-07 = its ЕИК (or ЕГН), and 999999999999999 for a person with neither. Is that what you file?",
	"Documents dated before the registration took effect are left out of the journals. Any purchase that qualifies for credit under чл. 74 ЗДДС (assets still held) you want to add by hand?",
	"Amounts are in EUR under the Euro Introduction Act, чл. 50, ал. 1, although ППЗДДС Приложение № 12 still says leva. Please check the files with the NRA program „Дневници по ЗДДС“ (v15.01 or later) before the first upload.",
];

/** The SUMMARY.md text for the month. */
export function summaryMarkdown(input: SummaryInput): string {
	const { month, cells } = input;
	const w = month.window;
	const due = dueDate(w.month);
	const payable = cells.get("01-50") ?? 0;
	const refundable = cells.get("01-60") ?? 0;
	const v = (code: string) => centsToDecimal(cells.get(code) ?? 0);
	const out: string[] = [];
	if (input.demo) out.push("> **DEMO. Built from fixture data. Do not file.**", "");
	out.push(`# ДДС ${w.month}: справка-декларация, дневници${month.vies.length ? ", VIES" : ""}`, "");
	out.push(`- Filer: ${month.filer.vatNumber}, registered under чл. 100, ал. 1 ЗДДС from ${bgDate(month.registration.effectiveDate)}.`);
	out.push(`- Period: ${bgDate(w.firstDay)} to ${bgDate(w.lastDay)}.`);
	if (payable > 0 || refundable === 0) {
		out.push(`- **VAT payable (cell 50): EUR ${centsToDecimal(payable)}**${cells.get("01-70") ? ` (set off EUR ${v("01-70")}, pay EUR ${v("01-71")})` : ""}. File and pay by **${bgDate(due)}** (ЗДДС чл. 125, ал. 5; чл. 89, ал. 1).`);
	} else {
		out.push(`- **VAT refundable (cell 60): EUR ${centsToDecimal(refundable)}**, set off under чл. 92, ал. 1 (cell 80). File by **${bgDate(due)}** (ЗДДС чл. 125, ал. 5).`);
	}
	out.push(`- Output VAT (cell 20) EUR ${v("01-20")}; input VAT credit (cell 40) EUR ${v("01-40")}. Reverse charge on received services nets to 0 (01-22 is also in 01-41).`);
	out.push(
		`- Sales journal: ${month.sales.length} line(s). Purchase journal: ${month.purchases.length} line(s). Protocols: ${month.protocols.length}. VIES: ${month.vies.length ? `${month.vies.length} line(s), file VIES.TXT` : "not filed this month (no EU B2B service sales)"}.`,
	);
	if (!month.sales.length && !month.purchases.length) out.push("- **Nil month.** The return is still filed (ЗДДС чл. 125, ал. 4); the journals are empty files.");
	out.push("", "## What to check (about 15 minutes)", "");
	out.push("1. Each protocol below against the supplier's invoice: supplier, number, date, net amount, rate.");
	out.push("2. Each sale against its фактура: the cell (20 % / чл. 21, ал. 2 / чл. 69, ал. 2) and, for EU sales, the customer's VAT number in VIES (ec.europa.eu/taxation_customs/vies).");
	out.push("3. Each Bulgarian purchase against its фактура: VAT number, base, VAT, credit right.");
	out.push("4. The documents left out (below): each reason should be right.");
	out.push(`5. Load the files into the NRA program „Дневници по ЗДДС“ (v15.01+) or the portal's check, then upload: ${input.files.join(", ")}.`);
	out.push(payable > 0 ? `6. Pay EUR ${v("01-71")} by ${bgDate(due)}, quoting the return's incoming number.` : "6. Nothing to pay this month.");

	out.push("", "## Справка-декларация (DEKLAR.TXT)", "", "| Cell | Description | EUR |", "|---|---|---:|");
	for (const field of DEKLAR_FIELDS) {
		if (field.format === "amount") out.push(`| ${field.code} | ${cell(field.name)} | ${v(field.code)} |`);
		if (field.format === "coefficient") out.push(`| ${field.code} | ${cell(field.name)} | 0.00 |`);
	}

	out.push("", "## Дневник за продажбите (PRODAGBI.TXT)", "");
	if (!month.sales.length) out.push("No lines.");
	else {
		out.push("| # | Type | Number | Date | Counterparty | ID | Cells |", "|---:|---|---|---|---|---|---|");
		month.sales.forEach((e, i) => {
			out.push(`| ${i + 1} | ${e.docType} | ${e.number} | ${bgDate(e.date)} | ${cell(e.counterpartyName)} | ${e.counterpartyId} | ${cellList(salesAmounts(e))} |`);
		});
	}

	out.push("", "## Дневник за покупките (POKUPKI.TXT)", "");
	if (!month.purchases.length) out.push("No lines.");
	else {
		out.push("| # | Type | Number | Date | Supplier | ID | Cells |", "|---:|---|---|---|---|---|---|");
		month.purchases.forEach((e, i) => {
			out.push(`| ${i + 1} | ${e.docType} | ${e.number} | ${bgDate(e.date)} | ${cell(e.counterpartyName)} | ${e.counterpartyId} | ${cellList(e.cells)} |`);
		});
	}

	out.push("", "## Протоколи по чл. 117 ЗДДС", "");
	if (!month.protocols.length) out.push("None this month.");
	else {
		out.push("| Number | Date | Supplier | Supplier invoice | Tax event | Base | VAT 20 % |", "|---|---|---|---|---|---:|---:|");
		for (const p of month.protocols) {
			out.push(
				`| ${p.number} | ${bgDate(p.issueDate)} | ${cell(p.supplier.name)} | ${cell(`${p.supplierDocument.number} / ${bgDate(p.supplierDocument.date)}`)} | ${bgDate(p.taxEventDate)} | ${centsToDecimal(p.base)} | ${centsToDecimal(p.vat)} |`,
			);
		}
	}

	if (month.vies.length) {
		out.push("", "## VIES (VIES.TXT)", "", "| # | VAT number | Services (чл. 21, ал. 2) | Period |", "|---:|---|---:|---|");
		month.vies.forEach((l, i) => out.push(`| ${i + 1} | ${l.vatNumber} | ${centsToDecimal(l.servicesBase)} | ${l.period} |`));
	}

	out.push("", "## Documents of the month not in the journals", "");
	if (!month.unrecorded.length) out.push("None.");
	else {
		out.push("| Side | Number | Date | Counterparty | Country | Net EUR | Why |", "|---|---|---|---|---|---:|---|");
		for (const x of month.unrecorded) {
			out.push(`| ${x.side} | ${cell(x.number)} | ${bgDate(x.date)} | ${cell(x.counterparty)} | ${x.country} | ${centsToDecimal(x.netEur)} | ${cell(x.reason)} |`);
		}
	}

	const notes = [...month.notes, ...input.textNotes];
	if (notes.length) {
		out.push("", "## Notes", "");
		for (const n of notes) out.push(`- ${n}`);
	}
	out.push("", "## Questions for the accountant (open)", "");
	ACCOUNTANT_QUESTIONS.forEach((q, i) => out.push(`${i + 1}. ${q}`));
	out.push("", "Formats and sources: docs/legal/NRA_FILE_FORMATS.md in the Alethia repository.", "");
	return out.join("\n");
}
