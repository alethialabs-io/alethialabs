// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The body of `pnpm factura:issue-manual` (scripts/factura-issue-manual.ts), kept here so the
// dry-run/issue split and the input validation are unit-tested without a database or a process.
//
// DRY RUN BY DEFAULT. Without `--issue` it validates the input, decides the VAT treatment, looks up
// the EUR rate and the key, and prints the document exactly as it would be issued — but takes no
// number and writes nothing. `--issue` issues it (manual.ts). The input is a JSON file (`--file`)
// or flags for the common one-line case; never both, so what was validated is what was asked.

import type { z } from "zod";
import type { FacturaSnapshot } from "@/types/jsonb.types";
import { facturaLayout, layoutText } from "./layout";
import {
	issueManualCreditNote,
	issueManualFactura,
	type ManualDeps,
	type ManualIssued,
	type ManualRefusal,
	manualCreditNoteInputSchema,
	manualFacturaInputSchema,
	proposeManualCreditNote,
	proposeManualFactura,
} from "./manual";

/** How to run it, printed on a usage error. */
export const ISSUE_MANUAL_USAGE = `usage:
  factura:issue-manual -- --file=<input.json> [--issue]
  factura:issue-manual -- --key=<key> --recipient-name=<name> --recipient-address=<street>
      --recipient-city=<city> --recipient-country=<CC> (--recipient-vat=<VAT> | --recipient-id=<id>)
      --chargeable-date=<YYYY-MM-DD> --description=<text> --amount=<1234.56>
      [--currency=EUR] [--quantity=1] [--period-start=<YYYY-MM-DD> --period-end=<YYYY-MM-DD>]
      [--recipient-address2=…] [--recipient-postal-code=…] [--recipient-state=…]
      [--reference=<text>] [--org=<organization uuid>] [--issue]
  factura:issue-manual -- --credit-note --key=<key> --original=<number> --reason=<text>
      --chargeable-date=<YYYY-MM-DD> [--amount=<taxable amount; omitted: the whole фактура>] [--issue]
  factura:issue-manual -- --credit-note --file=<input.json> [--issue]
Without --issue nothing is issued: the proposed document is printed.`;

/** The flags that select a mode rather than carry input. */
const MODE_FLAGS = new Set(["issue", "credit-note"]);

/** Everything the CLI touches outside itself, replaceable in tests. */
export interface IssueManualCliDeps {
	readFile: (path: string) => Promise<string>;
	out: (line: string) => void;
	err: (line: string) => void;
	manual: Partial<ManualDeps>;
}

/** `--name=value` and bare `--name` flags of `argv`; null when an argument is not a flag. */
function parseFlags(argv: readonly string[]): Map<string, string> | null {
	const flags = new Map<string, string>();
	for (const a of argv) {
		const m = /^--([a-z0-9-]+)(?:=([\s\S]*))?$/.exec(a);
		if (!m) return null;
		flags.set(m[1], m[2] ?? "");
	}
	return flags;
}

/** An object without its undefined values, so zod's `optional()` sees absent rather than "". */
function defined(o: { [key: string]: unknown }): { [key: string]: unknown } {
	return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== ""));
}

/** The фактура input the flags describe (a single line). */
function facturaFromFlags(f: Map<string, string>): unknown {
	const quantity = f.get("quantity");
	return defined({
		key: f.get("key"),
		organizationId: f.get("org"),
		recipient: defined({
			name: f.get("recipient-name"),
			addressLine1: f.get("recipient-address"),
			addressLine2: f.get("recipient-address2"),
			postalCode: f.get("recipient-postal-code"),
			city: f.get("recipient-city"),
			state: f.get("recipient-state"),
			country: f.get("recipient-country"),
			vatNumber: f.get("recipient-vat"),
			companyId: f.get("recipient-id"),
		}),
		chargeableDate: f.get("chargeable-date"),
		currency: f.get("currency"),
		reference: f.get("reference"),
		lines: [
			defined({
				description: f.get("description"),
				unitAmount: f.get("amount"),
				quantity: quantity === undefined ? undefined : Number(quantity),
				periodStart: f.get("period-start"),
				periodEnd: f.get("period-end"),
			}),
		],
	});
}

/** The credit-note input the flags describe. */
function creditNoteFromFlags(f: Map<string, string>): unknown {
	return defined({
		key: f.get("key"),
		originalNumber: f.get("original"),
		amount: f.get("amount"),
		reason: f.get("reason"),
		chargeableDate: f.get("chargeable-date"),
	});
}

/** Each zod issue as one `path: message` line. */
function issueLines(error: z.ZodError): string[] {
	return error.issues.map((i) => `  ${i.path.length ? i.path.join(".") : "(input)"}: ${i.message}`);
}

/** Prints a proposed or issued document. */
function printDocument(snapshot: FacturaSnapshot, out: (line: string) => void): void {
	out(layoutText(facturaLayout(snapshot)));
	out("");
	out(`VAT treatment: ${snapshot.vatTreatment ?? "unregistered"}${snapshot.vatRatePercent ? ` (${snapshot.vatRatePercent}%)` : ""}`);
}

/** Prints a refusal; returns the exit code. */
function refused(r: ManualRefusal, err: (line: string) => void): number {
	err(`refused (${r.reason}): ${r.detail}`);
	return 1;
}

/** Prints an issue result; returns the exit code. */
function issuedResult(r: ManualIssued | ManualRefusal, d: IssueManualCliDeps, kind: string): number {
	if (!r.ok) return refused(r, d.err);
	for (const w of r.warnings) d.err(`warning: ${w}`);
	d.out(
		r.replayed
			? `already issued: ${kind} ${r.document.number} (the key was used before; nothing new was issued)`
			: `issued: ${kind} ${r.document.number}`,
	);
	d.out(`pdf: ${r.document.pdfKey}`);
	return 0;
}

/**
 * Runs `factura:issue-manual` for `argv`; returns the exit code: 0 — proposed or issued; 1 — the
 * input is invalid or the document was refused; 2 — a usage error.
 */
export async function runIssueManualCli(argv: readonly string[], d: IssueManualCliDeps): Promise<number> {
	const flags = parseFlags(argv);
	if (!flags || flags.size === 0) {
		d.err(ISSUE_MANUAL_USAGE);
		return 2;
	}
	const issue = flags.has("issue");
	const creditNote = flags.has("credit-note");
	const file = flags.get("file");
	const inputFlags = [...flags.keys()].filter((k) => !MODE_FLAGS.has(k) && k !== "file");
	if (file !== undefined && inputFlags.length > 0) {
		d.err(`refused: --file cannot be combined with input flags (${inputFlags.map((k) => `--${k}`).join(", ")})`);
		return 2;
	}

	let raw: unknown;
	if (file !== undefined) {
		try {
			raw = JSON.parse(await d.readFile(file));
		} catch (e) {
			d.err(`refused: ${file} is not a readable JSON file (${e instanceof Error ? e.message : String(e)})`);
			return 1;
		}
	} else {
		raw = creditNote ? creditNoteFromFlags(flags) : facturaFromFlags(flags);
	}

	if (creditNote) {
		const parsed = manualCreditNoteInputSchema.safeParse(raw);
		if (!parsed.success) {
			d.err("invalid credit-note input:");
			for (const line of issueLines(parsed.error)) d.err(line);
			return 1;
		}
		if (issue) return issuedResult(await issueManualCreditNote(parsed.data, d.manual), d, "credit note");
		const proposal = await proposeManualCreditNote(parsed.data, d.manual);
		if (!proposal.ok) return refused(proposal, d.err);
		printDocument(proposal.snapshot, d.out);
		for (const w of proposal.warnings) d.err(`warning: ${w}`);
		d.out(
			proposal.existing
				? `dry run: key ${parsed.data.key} is already issued as credit note ${proposal.existing.number}; --issue returns it`
				: "dry run: nothing was issued; re-run with --issue to issue this credit note",
		);
		return 0;
	}

	const parsed = manualFacturaInputSchema.safeParse(raw);
	if (!parsed.success) {
		d.err("invalid фактура input:");
		for (const line of issueLines(parsed.error)) d.err(line);
		return 1;
	}
	if (issue) return issuedResult(await issueManualFactura(parsed.data, d.manual), d, "фактура");
	const proposal = await proposeManualFactura(parsed.data, d.manual);
	if (!proposal.ok) return refused(proposal, d.err);
	printDocument(proposal.snapshot, d.out);
	// The organization decides who can read the document in the console (RLS), so it is shown.
	d.out(
		parsed.data.organizationId
			? `Readable by the members of organization ${parsed.data.organizationId}`
			: "Readable by no organization (operator only)",
	);
	for (const w of proposal.warnings) d.err(`warning: ${w}`);
	d.out(
		proposal.existing
			? `dry run: key ${parsed.data.key} is already issued as фактура ${proposal.existing.number}; --issue returns it`
			: "dry run: nothing was issued; re-run with --issue to issue this фактура",
	);
	return 0;
}
