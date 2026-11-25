// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// nra:protocol: issues one чл. 117 protocol for one reverse-charge purchase, on the day, within the
// 15 days of чл. 117, ал. 3 ЗДДС — the books workflow's daily step. No database, no network, no
// secrets. The protocol is @repo/nra's (buildSingleProtocol); this script renders it to PDF with
// the console's renderer and writes the PDF and a plain-text copy.
//
//   pnpm -C apps/console run nra:protocol -- --input=<purchase.json> --number=<n> [--out=<dir>] [--today=YYYY-MM-DD]
//   pnpm -C apps/console run nra:protocol -- --input <protocol.json> --out <dir>
//
// Flags take "--name=value" or "--name value". The input is one of two shapes:
//  - a purchase request (below), which the package numbers (--number) and computes;
//  - the books workflow's ProtocolData (alethialabs-io/books tools/src/protocols/renderer.ts): a
//    protocol already numbered and computed in cents, which the package re-checks (20 %, the sum of
//    the lines, full credit) and renders; --number is then optional and must match when given.
//
// purchase.json is {"version": 2, "filer": {"vatNumber": "BG…"}, "purchase": {…one purchase of
// nra-input.json…}, "issueDate"?: "YYYY-MM-DD"} (packages/nra/src/input.ts). --number is the next
// number of the protocol series (the caller keeps the series). Without an issueDate the protocol is
// dated the earlier of today and the tax event plus 15 days. Writes <out>/<number>.pdf and
// <out>/<number>.txt (default out: the current folder) and refuses to overwrite either. Record the
// number and date in the month's nra-input.json (protocolNumber, protocolDate) so the month's build
// reproduces the same protocol.
//
// Exit codes: 0 — written; 1 — refused or could not run.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
	buildSingleProtocol,
	centsToDecimal,
	isProtocolData,
	parseProtocolRequest,
	protocolFromData,
	protocolLayout,
	protocolText,
	type ReverseChargeProtocol,
} from "@repo/nra";
import { allowEsmOnlyPackages, userCwd } from "./lib/esm-only-packages";

/** The value of `--name=value` or `--name value` in `argv`, or null. */
function arg(argv: readonly string[], name: string): string | null {
	const prefix = `--${name}=`;
	const joined = argv.find((a) => a.startsWith(prefix));
	if (joined) return joined.slice(prefix.length);
	const at = argv.indexOf(`--${name}`);
	const next = at >= 0 ? argv[at + 1] : undefined;
	return next !== undefined && !next.startsWith("--") ? next : null;
}

/** Today in Sofia, YYYY-MM-DD. */
function sofiaToday(): string {
	return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Sofia", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

/** Runs the command for `argv`; returns the exit code. */
async function main(argv: readonly string[]): Promise<number> {
	const inputPath = arg(argv, "input");
	const number = arg(argv, "number");
	if (!inputPath) {
		console.error("usage: nra:protocol -- --input=<purchase.json|protocol.json> [--number=<n>] [--out=<dir>] [--today=YYYY-MM-DD]");
		return 1;
	}
	const cwd = userCwd();
	const text = await readFile(resolve(cwd, inputPath), "utf8");
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (err) {
		console.error(`refused: ${inputPath} is not JSON: ${err instanceof Error ? err.message : String(err)}`);
		return 1;
	}
	let p: ReverseChargeProtocol;
	let vat: string;
	let notes: string[];
	if (isProtocolData(raw)) {
		const built = protocolFromData(raw);
		if (!built.ok) {
			console.error("refused: the protocol cannot be issued as specified:");
			for (const problem of built.problems) console.error(`  ${problem}`);
			return 1;
		}
		if (number && number.padStart(10, "0") !== built.value.protocol.number) {
			console.error(`refused: --number ${number} differs from the input's number ${built.value.protocol.number}`);
			return 1;
		}
		({ protocol: p, filerVat: vat, notes } = built.value);
	} else {
		const request = parseProtocolRequest(text);
		if (!request.ok) {
			console.error(`refused: ${inputPath} is not a valid protocol request:`);
			for (const problem of request.problems) console.error(`  ${problem}`);
			return 1;
		}
		if (!number) {
			console.error("refused: a purchase request needs --number=<n>, the next number of the protocol series");
			return 1;
		}
		const built = buildSingleProtocol(request.value, number, arg(argv, "today") ?? sofiaToday());
		if (!built.ok) {
			console.error("refused: the protocol cannot be issued as specified:");
			for (const problem of built.problems) console.error(`  ${problem}`);
			return 1;
		}
		p = built.protocol;
		vat = request.value.filer.vatNumber;
		notes = built.notes;
	}
	await allowEsmOnlyPackages();
	const { renderProtocolPdf } = await import("@/lib/billing/nra/protocol-document");
	const out = resolve(cwd, arg(argv, "out") ?? ".");
	await mkdir(out, { recursive: true });
	await writeFile(join(out, `${p.number}.pdf`), await renderProtocolPdf(p, vat), { flag: "wx" });
	await writeFile(join(out, `${p.number}.txt`), `${protocolText(protocolLayout(p, vat))}\n`, { flag: "wx" });
	for (const n of notes) console.warn(`note: ${n}`);
	console.log(
		`wrote ${join(out, p.number)}.pdf/.txt: protocol ${p.number} of ${p.issueDate}, ${p.supplier.name}, base EUR ${centsToDecimal(p.base)}, VAT EUR ${centsToDecimal(p.vat)}. ` +
			`Record protocolNumber "${p.number}" and protocolDate "${p.issueDate}" on the purchase in the month's nra-input.json.`,
	);
	return 0;
}

main(process.argv.slice(2)).then(
	(code) => process.exit(code),
	(err: unknown) => {
		console.error("nra:protocol failed:", err instanceof Error ? err.message : err);
		process.exit(1);
	},
);
