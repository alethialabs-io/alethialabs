// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// nra/SUMMARY.md: what the person who files reads first (#7457). It states what to check, every
// DEKLAR cell with its value, each journal line, the VIES lines, the documents left out and why, the
// VAT payable and its due date, and the questions the generator cannot answer. Pure and
// deterministic, like the files it describes.

import { centsToDecimal } from "./record";
import type { DeklarCells } from "./files";
import { DEKLAR_FIELDS } from "./layout";
import type { NraMonth } from "./month";

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

/** What the summary is written from. */
export interface SummaryInput {
	month: NraMonth;
	cells: DeklarCells;
	textNotes: readonly string[];
	/** The file names written into nra/, for the checklist. */
	files: readonly string[];
	/** True for a `--demo` run: the summary says so on its first line. */
	demo: boolean;
}

/** The questions only the accountant can answer; repeated every month until answered in code. */
export const ACCOUNTANT_QUESTIONS: readonly string[] = [
	"Stripe's card-processing fee: exempt under чл. 46, ал. 1, т. 3 ЗДДС, or self-charged at 20 % like the Billing fees? The input file's stripe.processingFees records your answer.",
	"Is one protocol per Stripe monthly statement right, dated on the last day of the month with the tax event on that day? Or one per fee deduction?",
	"Protocol numbering: may the чл. 117 protocols run in their own ten-digit series (as generated), or must they share the фактура series?",
	"Purchase journal: ППЗДДС чл. 113, ал. 3 lets a чл. 97а person skip it and file one record of zeros. These files record each protocol in 03-30 instead. Which do you want?",
	"DEKLAR 01-33 (coefficient) is written as 0.00 and 01-71 (paid effectively) equal to 01-50. Correct for a чл. 97а-only return?",
	"Amounts are in EUR under the Euro Introduction Act, чл. 50, ал. 1, although ППЗДДС Приложение № 12 still says leva. Does the NRA portal accept these files (check them with the NRA's own program, version 15.01 or later, before the first upload)?",
];

/** The SUMMARY.md text for the month. */
export function summaryMarkdown(input: SummaryInput): string {
	const { month, cells } = input;
	const w = month.window;
	const due = dueDate(w.month);
	const payable = cells.get("01-50") ?? 0;
	const out: string[] = [];
	if (input.demo) out.push("> **DEMO. Built from fixture data. Do not file.**", "");
	out.push(`# ДДС ${w.month}: справка-декларация, дневници${month.vies.length ? ", VIES" : ""}`, "");
	out.push(`- Filer: ${month.filer.vatNumber}, registered under чл. 97а ЗДДС only.`);
	out.push(`- Period: ${bgDate(w.firstDay)} to ${bgDate(w.lastDay)}.`);
	out.push(`- **VAT payable (cell 50): EUR ${centsToDecimal(payable)}.** File and pay by **${bgDate(due)}** (ЗДДС чл. 125, ал. 5; чл. 89, ал. 1).`);
	out.push(`- Sales journal: ${month.sales.length} line(s). Purchase journal: ${month.purchases.length} line(s). VIES: ${month.vies.length ? `${month.vies.length} line(s), file VIES.TXT` : "not filed this month (no EU B2B service sales)"}.`);
	if (!month.sales.length && !month.purchases.length) out.push("- **Nil month.** The return is still filed (ЗДДС чл. 125, ал. 4); the journals are empty files.");
	out.push("", "## What to check (about 15 minutes)", "");
	out.push("1. Each protocol below against the supplier's invoice or Stripe's monthly tax statement: supplier, number, date, net amount.");
	out.push("2. Each EU sale against its фактура, and the customer's VAT number in VIES (ec.europa.eu/taxation_customs/vies).");
	out.push("3. The documents left out (below): each reason should be right.");
	out.push("4. Load the files into the NRA program „Дневници по ЗДДС“ (v15.01+) or the portal's check, then upload: " + input.files.join(", ") + ".");
	out.push(`5. Pay EUR ${centsToDecimal(payable)} by ${bgDate(due)}, quoting the return's incoming number.`);

	out.push("", "## Справка-декларация (DEKLAR.TXT)", "", "| Cell | Description | EUR |", "|---|---|---:|");
	for (const field of DEKLAR_FIELDS) {
		if (field.format !== "amount") continue;
		out.push(`| ${field.code} | ${cell(field.name)} | ${centsToDecimal(cells.get(field.code) ?? 0)} |`);
	}
	out.push(`| 01-33 | Коефициент по чл. 73, ал. 5 ЗДДС | 0.00 |`);

	out.push("", "## Дневник за продажбите (PRODAGBI.TXT)", "");
	if (!month.sales.length) out.push("No lines.");
	else {
		out.push("| # | Type | Number | Date | Counterparty | ID | 02-17 | 02-26 | 02-22 |", "|---:|---|---|---|---|---|---:|---:|---:|");
		month.sales.forEach((e, i) => {
			out.push(
				`| ${i + 1} | ${e.docType} | ${e.number} | ${bgDate(e.date)} | ${cell(e.counterpartyName)} | ${e.counterpartyId} | ${centsToDecimal(e.euServiceBase)} | ${centsToDecimal(e.reverseChargeBase)} | ${centsToDecimal(e.reverseChargeVat)} |`,
			);
		});
	}

	out.push("", "## Дневник за покупките (POKUPKI.TXT)", "");
	if (!month.purchases.length) out.push("No lines.");
	else {
		out.push("| # | Type | Number | Date | Supplier | ID | 03-30 (base + VAT, no credit) |", "|---:|---|---|---|---|---|---:|");
		month.purchases.forEach((e, i) => {
			out.push(`| ${i + 1} | ${e.docType} | ${e.number} | ${bgDate(e.date)} | ${cell(e.counterpartyName)} | ${e.counterpartyId} | ${centsToDecimal(e.noCreditBaseAndVat)} |`);
		});
	}

	out.push("", "## Протоколи по чл. 117 ЗДДС", "");
	if (!month.protocols.length) out.push("None this month.");
	else {
		out.push("| Number | Supplier | Supplier invoice | Tax event | Base | VAT 20 % |", "|---|---|---|---|---:|---:|");
		for (const p of month.protocols) {
			const doc = p.supplierDocument ? `${p.supplierDocument.number} / ${bgDate(p.supplierDocument.date)}` : "not yet issued";
			out.push(`| ${p.number} | ${cell(p.supplier.name)} | ${cell(doc)} | ${bgDate(p.taxEventDate)} | ${centsToDecimal(p.base)} | ${centsToDecimal(p.vat)} |`);
		}
	}
	const s = month.stripe;
	out.push(
		"",
		`Stripe fees this month: software (Billing, Tax, Radar) EUR ${centsToDecimal(s.software)}, card processing EUR ${centsToDecimal(s.processing)}` +
			(s.processingTreatment ? ` (treated as ${s.processingTreatment}).` : "."),
	);

	if (month.vies.length) {
		out.push("", "## VIES (VIES.TXT)", "", "| # | VAT number | Services (чл. 21, ал. 2) | Period |", "|---:|---|---:|---|");
		month.vies.forEach((l, i) => out.push(`| ${i + 1} | ${l.vatNumber} | ${centsToDecimal(l.servicesBase)} | ${l.period} |`));
	}

	out.push("", "## Documents of the month not in the journals", "");
	if (!month.excluded.length) out.push("None.");
	else {
		out.push("| Number | Kind | Recipient | Country | Base EUR | Why |", "|---|---|---|---|---:|---|");
		for (const x of month.excluded) {
			out.push(`| ${x.number} | ${x.kind} | ${cell(x.recipient)} | ${x.country} | ${centsToDecimal(x.baseEur)} | ${cell(x.reason)} |`);
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
