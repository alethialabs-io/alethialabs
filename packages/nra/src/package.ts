// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A month's whole NRA package from its two inputs: the four files, the чл. 117 protocols (a rendered
// document and a plain-text copy of each) and SUMMARY.md. Names are relative; the caller places them
// (the console's export under nra/, `nra:build` in its --out folder).
//
//   DEKLAR.TXT  PRODAGBI.TXT  POKUPKI.TXT  [VIES.TXT]  SUMMARY.md
//   protocols/<number>.pdf  protocols/<number>.txt
//
// A protocol already issued on its day (a purchase with protocolNumber and protocolDate) is written
// again with the same number, date and text (its .txt is byte-identical; a PDF renderer may embed a
// different font subset in another process).

import { buildNraFiles, type DeklarCells, type NraFiles } from "./files";
import type { NraInput, SalesFile } from "./input";
import { buildNraMonth, type NraMonth } from "./month";
import { type ProtocolRenderer, protocolLayout, protocolText } from "./protocol";
import { NraError } from "./record";
import { summaryMarkdown } from "./summary";

/** One file of the package. */
export interface NraOutputFile {
	/** Relative path, "/" separated. */
	name: string;
	data: Uint8Array;
}

/** The package of a month, or the problems that stop it. */
export type NraPackage =
	| { ok: true; files: NraOutputFile[]; cells: DeklarCells; month: NraMonth }
	| { ok: false; problems: string[] };

/**
 * The package for `sales` and `input`. Refuses — returns problems and no files — when the month
 * cannot be built (month.ts) or a value does not fit its field (record.ts): a partial package is
 * never written. `render` makes each protocol's document; null writes the .txt copies only.
 */
export async function buildNraPackage(
	sales: SalesFile,
	input: NraInput,
	render: ProtocolRenderer | null,
	options: { demo: boolean } = { demo: false },
): Promise<NraPackage> {
	const built = buildNraMonth({ sales, input });
	if (!built.ok) return built;
	const month = built.month;
	let nra: NraFiles;
	try {
		nra = buildNraFiles(month, input.vies);
	} catch (err) {
		if (err instanceof NraError) return { ok: false, problems: [err.message] };
		throw err;
	}
	const enc = new TextEncoder();
	const files: NraOutputFile[] = [
		{ name: "DEKLAR.TXT", data: nra.deklar },
		{ name: "PRODAGBI.TXT", data: nra.prodagbi },
		{ name: "POKUPKI.TXT", data: nra.pokupki },
	];
	if (nra.vies) files.push({ name: "VIES.TXT", data: nra.vies });
	for (const p of month.protocols) {
		if (render) files.push({ name: `protocols/${p.number}.pdf`, data: await render(p, month.filer.vatNumber) });
		files.push({ name: `protocols/${p.number}.txt`, data: enc.encode(`${protocolText(protocolLayout(p, month.filer.vatNumber))}\n`) });
	}
	const summary = summaryMarkdown({
		month,
		cells: nra.cells,
		textNotes: nra.textNotes,
		files: files.filter((f) => f.name.endsWith(".TXT")).map((f) => f.name),
		demo: options.demo,
	});
	files.push({ name: "SUMMARY.md", data: enc.encode(summary) });
	return { ok: true, files, cells: nra.cells, month };
}
