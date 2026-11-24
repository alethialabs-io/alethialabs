// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// nra:build: a month's NRA VAT package from two JSON files, with no database, no network and no
// secrets — the step the books workflow runs after the console's export (facturi-M.json) and its own
// purchase intake (nra-input.json). The package is @repo/nra's; this script only reads the files,
// renders each protocol to PDF with the console's renderer, and writes the result.
//
//   pnpm -C apps/console run nra:build -- --facturi=<facturi-YYYY-MM.json> --input=<nra-input.json> --out=<dir> [--demo]
//
// Writes into --out, which must not exist yet (a past package is never overwritten):
//   DEKLAR.TXT PRODAGBI.TXT POKUPKI.TXT [VIES.TXT] SUMMARY.md protocols/<n>.pdf protocols/<n>.txt
// plus MANIFEST.sha256 over every file, in `sha256sum` format. `--demo` marks SUMMARY.md as built
// from fixture data. Relative paths are read from the folder pnpm was run in.
//
// Exit codes: 0 — written; 1 — refused (the problems are listed) or could not run.

import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { buildNraPackage, centsToDecimal, parseNraInput, parseSalesFile } from "@repo/nra";
import { allowEsmOnlyPackages, userCwd } from "./lib/esm-only-packages";

/** The value of `--name=value` in `argv`, or null. */
function arg(argv: readonly string[], name: string): string | null {
	const prefix = `--${name}=`;
	return argv.find((a) => a.startsWith(prefix))?.slice(prefix.length) ?? null;
}

/** True when `path` exists. */
async function exists(path: string): Promise<boolean> {
	return stat(path).then(
		() => true,
		() => false,
	);
}

/** Runs the build for `argv`; returns the exit code. */
async function main(argv: readonly string[]): Promise<number> {
	const facturiPath = arg(argv, "facturi");
	const inputPath = arg(argv, "input");
	const outArg = arg(argv, "out");
	if (!facturiPath || !inputPath || !outArg) {
		console.error("usage: nra:build -- --facturi=<facturi-YYYY-MM.json> --input=<nra-input.json> --out=<dir> [--demo]");
		return 1;
	}
	const cwd = userCwd();
	const out = resolve(cwd, outArg);
	if (await exists(out)) {
		console.error(`refused: ${out} already exists; choose another --out, a past package is never overwritten`);
		return 1;
	}
	const sales = parseSalesFile(await readFile(resolve(cwd, facturiPath), "utf8"));
	const input = parseNraInput(await readFile(resolve(cwd, inputPath), "utf8"));
	const problems = [
		...(sales.ok ? [] : sales.problems.map((p) => `${facturiPath}: ${p}`)),
		...(input.ok ? [] : input.problems.map((p) => `${inputPath}: ${p}`)),
	];
	if (!sales.ok || !input.ok) {
		console.error("refused: the input files are not valid:");
		for (const p of problems) console.error(`  ${p}`);
		return 1;
	}
	await allowEsmOnlyPackages();
	const { renderProtocolPdf } = await import("@/lib/billing/nra/protocol-document");
	const pkg = await buildNraPackage(sales.value, input.value, renderProtocolPdf, { demo: argv.includes("--demo") });
	if (!pkg.ok) {
		console.error(`refused: the VAT package for ${sales.value.month} cannot be built as specified:`);
		for (const p of pkg.problems) console.error(`  ${p}`);
		return 1;
	}
	const manifest: string[] = [];
	for (const file of pkg.files) {
		const path = join(out, file.name);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, file.data, { flag: "wx" });
		manifest.push(`${createHash("sha256").update(file.data).digest("hex")}  ${file.name}`);
	}
	await writeFile(join(out, "MANIFEST.sha256"), `${manifest.join("\n")}\n`, { flag: "wx" });
	const c = pkg.cells;
	console.log(
		`wrote ${out}: ${sales.value.month}, ${pkg.month.sales.length} sales line(s), ${pkg.month.purchases.length} purchase line(s), ${pkg.month.protocols.length} protocol(s). ` +
			`01-20 ${centsToDecimal(c.get("01-20") ?? 0)}, 01-40 ${centsToDecimal(c.get("01-40") ?? 0)}, 01-50 ${centsToDecimal(c.get("01-50") ?? 0)}, 01-60 ${centsToDecimal(c.get("01-60") ?? 0)}. Read SUMMARY.md.`,
	);
	return 0;
}

main(process.argv.slice(2)).then(
	(code) => process.exit(code),
	(err: unknown) => {
		console.error("nra:build failed:", err instanceof Error ? err.message : err);
		process.exit(1);
	},
);
