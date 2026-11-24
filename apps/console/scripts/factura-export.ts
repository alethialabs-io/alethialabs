// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The accountant's monthly export (#7369): every фактура and credit note issued in a month, their
// PDFs, a SHA-256 manifest, and Stripe's balance transactions for the same month so payouts and fees
// reconcile. The files and their format are described in lib/billing/factura/export.ts.
//
// With `--nra=<input.json>` it also writes `nra/`: the VAT return package of a company registered
// under чл. 97а ЗДДС (DEKLAR.TXT, PRODAGBI.TXT, POKUPKI.TXT, VIES.TXT when due, the чл. 117
// protocols and SUMMARY.md; lib/billing/nra/, #7457). The input file is described in
// lib/billing/nra/input.ts; it names the person who files, so keep it out of the repository.
//
// Usage (operator, against production):
//   pnpm creds prod-env -- pnpm -C apps/console run factura:export -- --month=2026-12 [--out=<dir>] [--nra=<input.json>]
//
// Demo (no database, no Stripe, no network): a full sample month from fixtures, every file the real
// run writes, so the package can be seen before the first real month:
//   pnpm -C apps/console run factura:export -- --demo --out=<dir>
//
// It writes into `--out` (default `./factura-export-<month>`), which must not exist yet, so a past
// export is never overwritten. It refuses, and writes nothing, when a document issued that month has
// no PDF yet or its stored PDF does not match the SHA-256 recorded at issue; it lists them. Wait for
// the фактура sweeper (it renders a missing PDF within the hour) and run it again. With `--nra` it
// also refuses when the VAT package cannot be built as specified (it lists why).
//
// Read-only: it reads the `factura` table, the invoice PDFs from object storage and Stripe's balance
// transactions and payouts. Reads ALETHIA_DATABASE_URL (the service connection), the storage
// variables and STRIPE_SECRET_KEY, the environment the console runs with. Exit codes: 0 — written;
// 1 — refused or could not run.

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { and, asc, gte, lte } from "drizzle-orm";
import type Stripe from "stripe";
import { type BalanceRow, buildExport, type ExportFile, monthWindow, type MonthWindow, sha256Hex } from "@/lib/billing/factura/export";
import { demoMonth } from "@/lib/billing/nra/demo";
import { type NraInput, parseNraInput } from "@/lib/billing/nra/input";
import { buildNraPackage } from "@/lib/billing/nra/package";
import { centsToDecimal } from "@/lib/billing/nra/record";
import { getStripe } from "@/lib/billing/stripe";
import { getServiceDb } from "@/lib/db";
import { type Factura, factura } from "@/lib/db/schema";
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

/**
 * Lets this script load the PDF renderer. tsx compiles the console's TypeScript to CommonJS, so
 * `@react-pdf/renderer` and its dependencies are `require`d, and `@react-pdf/hyphenate` publishes its
 * subpaths under the `import` condition only: resolution fails with ERR_PACKAGE_PATH_NOT_EXPORTED
 * before any PDF is drawn. Node (22.15+) can `require` an ES module synchronously; what is missing is
 * only the resolution, so this hook retries exactly that failure with the `import` condition added.
 * Next bundles the renderer for the server and never takes this path. `registerHooks` is not in the
 * console's @types/node (20), hence the runtime check.
 */
async function allowEsmOnlyPackages(): Promise<void> {
	const mod: unknown = await import("node:module");
	if (typeof mod !== "object" || mod === null || !("registerHooks" in mod) || typeof mod.registerHooks !== "function") return;
	mod.registerHooks({
		resolve(
			specifier: string,
			context: { conditions?: string[] },
			next: (s: string, c: { conditions?: string[] }) => unknown,
		): unknown {
			try {
				return next(specifier, context);
			} catch (err) {
				const code = typeof err === "object" && err !== null && "code" in err ? err.code : null;
				if (code !== "ERR_PACKAGE_PATH_NOT_EXPORTED" || !specifier.startsWith("@react-pdf/")) throw err;
				return next(specifier, { ...context, conditions: [...(context.conditions ?? []), "import"] });
			}
		},
	});
}

/** True when `argv` carries the bare flag `--name`. */
function flag(argv: readonly string[], name: string): boolean {
	return argv.includes(`--${name}`);
}

/** The month's documents, their PDFs and Stripe balance, read from production. */
async function readMonth(window: MonthWindow): Promise<{ documents: Factura[]; pdfs: Map<string, Uint8Array | null>; balance: BalanceRow[] }> {
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
	return { documents, pdfs, balance };
}

/** The fixture month of `--demo`, with each document's PDF rendered and attached as the issuer would. */
async function readDemoMonth(): Promise<{ window: MonthWindow; documents: Factura[]; pdfs: Map<string, Uint8Array | null>; balance: BalanceRow[]; operator: NraInput }> {
	await allowEsmOnlyPackages();
	const { renderFacturaPdf } = await import("@/lib/billing/factura/document");
	const demo = demoMonth();
	const pdfs = new Map<string, Uint8Array | null>();
	const documents: Factura[] = [];
	for (const doc of demo.documents) {
		const pdf = await renderFacturaPdf(doc.snapshot);
		pdfs.set(doc.number, pdf);
		documents.push({ ...doc, pdfKey: `demo/${doc.number}.pdf`, pdfSha256: sha256Hex(pdf) });
	}
	return { window: demo.window, documents, pdfs, balance: demo.balance, operator: demo.operator };
}

/** Runs the export for the arguments in `argv`; returns the exit code. */
async function main(argv: readonly string[]): Promise<number> {
	const demo = flag(argv, "demo");
	const month = demo ? null : arg(argv, "month");
	if (!demo && !month) {
		console.error("usage: factura:export -- --month=YYYY-MM [--out=<dir>] [--nra=<input.json>]   |   factura:export -- --demo --out=<dir>");
		return 1;
	}
	const outArg = arg(argv, "out");
	if (demo && !outArg) {
		console.error("refused: --demo needs --out=<dir>, a folder that does not exist yet");
		return 1;
	}

	let operator: NraInput | null = null;
	const nraPath = arg(argv, "nra");
	if (nraPath && !demo) {
		const parsed = parseNraInput(await readFile(resolve(nraPath), "utf8"));
		if (!parsed.ok) {
			console.error(`refused: ${nraPath} is not a valid NRA input file:`);
			for (const p of parsed.problems) console.error(`  ${p}`);
			return 1;
		}
		operator = parsed.input;
	}

	const data = demo ? await readDemoMonth() : { window: monthWindow(month ?? ""), ...(await readMonth(monthWindow(month ?? ""))) };
	const window = data.window;
	if (demo && "operator" in data) operator = data.operator;
	const out = resolve(outArg ?? `factura-export-${window.month}`);
	if (await exists(out)) {
		console.error(`refused: ${out} already exists; choose another --out, a past export is never overwritten`);
		return 1;
	}

	let extra: ExportFile[] = [];
	let vatLine = "";
	if (operator) {
		await allowEsmOnlyPackages();
		const { renderProtocolPdf } = await import("@/lib/billing/nra/protocol-document");
		const nra = await buildNraPackage(
			{ window, documents: data.documents, balance: data.balance, operator },
			renderProtocolPdf,
			{ demo },
		);
		if (!nra.ok) {
			console.error(`refused: the VAT package for ${window.month} cannot be built as specified:`);
			for (const p of nra.problems) console.error(`  ${p}`);
			return 1;
		}
		extra = nra.files;
		vatLine = ` VAT package in nra/ (VAT payable EUR ${centsToDecimal(nra.vatPayableCents)}; read nra/SUMMARY.md).`;
	}

	const result = buildExport(window, data.documents, data.pdfs, data.balance, extra);
	if (!result.ok) {
		console.error(`refused: ${result.problems.length} document(s) of ${window.month} cannot be exported as they stand:`);
		for (const p of result.problems) console.error(`  ${p.number}: ${p.problem}`);
		return 1;
	}
	for (const file of result.files) {
		const path = join(out, file.name);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, file.data, { flag: "wx" });
	}
	const credits = data.documents.filter((d) => d.kind === "credit_note").length;
	console.log(
		`wrote ${out}${demo ? " (DEMO, fixture data)" : ""}: ${data.documents.length - credits} фактура(и), ${credits} credit note(s), ` +
			`${data.balance.length} Stripe balance transaction(s).${vatLine} Verify: cd ${out} && unzip -q facturi-${window.month}-pdfs.zip && shasum -a 256 -c MANIFEST.sha256`,
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
