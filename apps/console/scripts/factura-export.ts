// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The accountant's monthly export (#7369): every фактура and credit note issued in a month, their
// PDFs, a SHA-256 manifest, and Stripe's balance transactions for the same month so payouts and fees
// reconcile. The files and their format are described in lib/billing/factura/export.ts.
//
// Usage (operator, against production):
//   pnpm creds prod-env -- pnpm -C apps/console run factura:export -- --month=2026-12 [--out=<dir>]
//
// It writes into `--out` (default `./factura-export-<month>`), which must not exist yet, so a past
// export is never overwritten. It refuses, and writes nothing, when a document issued that month has
// no PDF yet or its stored PDF does not match the SHA-256 recorded at issue; it lists them. Wait for
// the фактура sweeper (it renders a missing PDF within the hour) and run it again.
//
// Read-only: it reads the `factura` table, the invoice PDFs from object storage and Stripe's balance
// transactions and payouts. Reads ALETHIA_DATABASE_URL (the service connection), the storage
// variables and STRIPE_SECRET_KEY, the environment the console runs with. Exit codes: 0 — written;
// 1 — refused or could not run.

import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { and, asc, gte, lte } from "drizzle-orm";
import type Stripe from "stripe";
import { type BalanceRow, buildExport, monthWindow } from "@/lib/billing/factura/export";
import { getStripe } from "@/lib/billing/stripe";
import { getServiceDb } from "@/lib/db";
import { factura } from "@/lib/db/schema";
import { storage } from "@/lib/storage";
import { INVOICE_PDF_BUCKET } from "@/lib/storage/invoice-pdf";

/** Payouts arriving this many days after the month may still pay out its transactions. */
const PAYOUT_LOOKAHEAD_DAYS = 31;

/** The value of `--name=value` in `argv`, or null. */
function arg(argv: readonly string[], name: string): string | null {
	const prefix = `--${name}=`;
	return argv.find((a) => a.startsWith(prefix))?.slice(prefix.length) ?? null;
}

/** The id of a Stripe reference that may be expanded. */
function refId(ref: string | { id: string } | null | undefined): string | null {
	if (!ref) return null;
	return typeof ref === "string" ? ref : ref.id;
}

/**
 * Which payout each balance transaction settled in: lists the payouts that arrived from the month's
 * start to `PAYOUT_LOOKAHEAD_DAYS` after its end, and the transactions of each. A transaction paid
 * out later than that, or not yet, maps to nothing.
 */
async function payoutOfTransaction(stripe: Stripe, startEpoch: number, endEpoch: number): Promise<Map<string, string>> {
	const map = new Map<string, string>();
	const arrival = { gte: startEpoch, lt: endEpoch + PAYOUT_LOOKAHEAD_DAYS * 86_400 };
	for await (const payout of stripe.payouts.list({ arrival_date: arrival, limit: 100 })) {
		if (!payout.automatic) continue; // Stripe lists a payout's transactions only for automatic ones.
		for await (const bt of stripe.balanceTransactions.list({ payout: payout.id, limit: 100 })) {
			map.set(bt.id, payout.id);
		}
	}
	return map;
}

/** Every balance transaction created in the window, with the payout each settled in. */
async function balanceRows(stripe: Stripe, startEpoch: number, endEpoch: number): Promise<BalanceRow[]> {
	const payouts = await payoutOfTransaction(stripe, startEpoch, endEpoch);
	const rows: BalanceRow[] = [];
	for await (const bt of stripe.balanceTransactions.list({ created: { gte: startEpoch, lt: endEpoch }, limit: 100 })) {
		const source = refId(bt.source);
		rows.push({
			id: bt.id,
			created: bt.created,
			availableOn: bt.available_on,
			type: bt.type,
			reportingCategory: bt.reporting_category,
			description: bt.description,
			currency: bt.currency,
			amount: bt.amount,
			fee: bt.fee,
			net: bt.net,
			source,
			payoutId: bt.type === "payout" ? source : (payouts.get(bt.id) ?? null),
		});
	}
	return rows;
}

/** True when `path` exists. */
async function exists(path: string): Promise<boolean> {
	return stat(path).then(
		() => true,
		() => false,
	);
}

/** Runs the export for the arguments in `argv`; returns the exit code. */
async function main(argv: readonly string[]): Promise<number> {
	const month = arg(argv, "month");
	if (!month) {
		console.error("usage: factura:export -- --month=YYYY-MM [--out=<dir>]");
		return 1;
	}
	const window = monthWindow(month);
	const out = resolve(arg(argv, "out") ?? `factura-export-${month}`);
	if (await exists(out)) {
		console.error(`refused: ${out} already exists; choose another --out, a past export is never overwritten`);
		return 1;
	}

	const documents = await getServiceDb()
		.select()
		.from(factura)
		.where(and(gte(factura.issueDate, window.firstDay), lte(factura.issueDate, window.lastDay)))
		.orderBy(asc(factura.number));
	const pdfs = new Map<string, Uint8Array | null>();
	for (const doc of documents) {
		pdfs.set(doc.number, doc.pdfKey ? await storage.get(INVOICE_PDF_BUCKET, doc.pdfKey) : null);
	}
	const balance = await balanceRows(getStripe(), window.startEpoch, window.endEpoch);

	const result = buildExport(window, documents, pdfs, balance);
	if (!result.ok) {
		console.error(`refused: ${result.problems.length} document(s) of ${month} cannot be exported as they stand:`);
		for (const p of result.problems) console.error(`  ${p.number}: ${p.problem}`);
		return 1;
	}
	for (const file of result.files) {
		const path = join(out, file.name);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, file.data, { flag: "wx" });
	}
	const credits = documents.filter((d) => d.kind === "credit_note").length;
	console.log(
		`wrote ${out}: ${documents.length - credits} фактура(и), ${credits} credit note(s), ` +
			`${balance.length} Stripe balance transaction(s). Verify: cd ${out} && unzip -q facturi-${month}-pdfs.zip && shasum -a 256 -c MANIFEST.sha256`,
	);
	return 0;
}

main(process.argv.slice(2)).then(
	(code) => process.exit(code),
	(err: unknown) => {
		console.error("factura:export failed:", err instanceof Error ? err.message : err);
		process.exit(1);
	},
);
