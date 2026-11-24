// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// nra:protocol: issues one чл. 117 protocol for one reverse-charge purchase, on the day, within the
// 15 days of чл. 117, ал. 3 ЗДДС — the books workflow's daily step. No database, no network, no
// secrets. The protocol is @repo/nra's (buildSingleProtocol); this script renders it to PDF with
// the console's renderer and writes the PDF and a plain-text copy.
//
//   pnpm -C apps/console run nra:protocol -- --input=<purchase.json> --number=<n> [--out=<dir>] [--today=YYYY-MM-DD]
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
import { buildSingleProtocol, centsToDecimal, parseProtocolRequest, protocolLayout, protocolText } from "@repo/nra";
import { allowEsmOnlyPackages, userCwd } from "./lib/esm-only-packages";

/** The value of `--name=value` in `argv`, or null. */
function arg(argv: readonly string[], name: string): string | null {
	const prefix = `--${name}=`;
	return argv.find((a) => a.startsWith(prefix))?.slice(prefix.length) ?? null;
}

/** Today in Sofia, YYYY-MM-DD. */
function sofiaToday(): string {
	return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Sofia", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

/** Runs the command for `argv`; returns the exit code. */
async function main(argv: readonly string[]): Promise<number> {
	const inputPath = arg(argv, "input");
	const number = arg(argv, "number");
	if (!inputPath || !number) {
		console.error("usage: nra:protocol -- --input=<purchase.json> --number=<n> [--out=<dir>] [--today=YYYY-MM-DD]");
		return 1;
	}
	const cwd = userCwd();
	const request = parseProtocolRequest(await readFile(resolve(cwd, inputPath), "utf8"));
	if (!request.ok) {
		console.error(`refused: ${inputPath} is not a valid protocol request:`);
		for (const p of request.problems) console.error(`  ${p}`);
		return 1;
	}
	const today = arg(argv, "today") ?? sofiaToday();
	const built = buildSingleProtocol(request.value, number, today);
	if (!built.ok) {
		console.error("refused: the protocol cannot be issued as specified:");
		for (const p of built.problems) console.error(`  ${p}`);
		return 1;
	}
	const p = built.protocol;
	const vat = request.value.filer.vatNumber;
	await allowEsmOnlyPackages();
	const { renderProtocolPdf } = await import("@/lib/billing/nra/protocol-document");
	const out = resolve(cwd, arg(argv, "out") ?? ".");
	await mkdir(out, { recursive: true });
	await writeFile(join(out, `${p.number}.pdf`), await renderProtocolPdf(p, vat), { flag: "wx" });
	await writeFile(join(out, `${p.number}.txt`), `${protocolText(protocolLayout(p, vat))}\n`, { flag: "wx" });
	for (const n of built.notes) console.warn(`note: ${n}`);
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
