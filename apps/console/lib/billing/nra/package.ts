// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The `nra/` folder of the accountant's export (#7457): the four NRA files, the чл. 117 protocols
// (a PDF and a plain-text copy of each), and SUMMARY.md. The export (lib/billing/factura/export.ts)
// lists every one of them in MANIFEST.sha256.
//
//   nra/DEKLAR.TXT  nra/PRODAGBI.TXT  nra/POKUPKI.TXT  [nra/VIES.TXT]  nra/SUMMARY.md
//   nra/protocols/<number>.pdf  nra/protocols/<number>.txt

import type { ExportFile } from "@/lib/billing/factura/export";
import { buildNraFiles, type NraFiles } from "./files";
import type { NraInput } from "./input";
import { buildNraMonth, type NraMonthInput } from "./month";
import { protocolLayout, protocolText } from "./protocol";
import { NraError } from "./record";
import { summaryMarkdown } from "./summary";

/** Renders one protocol to PDF; injected so tests and callers choose the renderer. */
export type ProtocolRenderer = (p: Parameters<typeof protocolLayout>[0], filerVat: string) => Promise<Uint8Array>;

/** The package of a month, or the problems that stop it. */
export type NraPackage = { ok: true; files: ExportFile[]; vatPayableCents: number } | { ok: false; problems: string[] };

/**
 * The `nra/` files for a month. Refuses — returns problems and no files — when the month cannot be
 * built (month.ts) or a value does not fit its field (record.ts): a partial package is never written.
 */
export async function buildNraPackage(
	input: NraMonthInput,
	render: ProtocolRenderer,
	options: { demo: boolean } = { demo: false },
): Promise<NraPackage> {
	const built = buildNraMonth(input);
	if (!built.ok) return built;
	const month = built.month;
	const vies: NraInput["vies"] = input.operator.vies;
	let nra: NraFiles;
	try {
		nra = buildNraFiles(month, vies);
	} catch (err) {
		if (err instanceof NraError) return { ok: false, problems: [err.message] };
		throw err;
	}
	const enc = new TextEncoder();
	const files: ExportFile[] = [
		{ name: "nra/DEKLAR.TXT", data: nra.deklar },
		{ name: "nra/PRODAGBI.TXT", data: nra.prodagbi },
		{ name: "nra/POKUPKI.TXT", data: nra.pokupki },
	];
	if (nra.vies) files.push({ name: "nra/VIES.TXT", data: nra.vies });
	for (const p of month.protocols) {
		files.push({ name: `nra/protocols/${p.number}.pdf`, data: await render(p, month.filer.vatNumber) });
		files.push({ name: `nra/protocols/${p.number}.txt`, data: enc.encode(`${protocolText(protocolLayout(p, month.filer.vatNumber))}\n`) });
	}
	const summary = summaryMarkdown({
		month,
		cells: nra.cells,
		textNotes: nra.textNotes,
		files: files.filter((f) => f.name.endsWith(".TXT")).map((f) => f.name.slice("nra/".length)),
		demo: options.demo,
	});
	files.push({ name: "nra/SUMMARY.md", data: enc.encode(summary) });
	return { ok: true, files, vatPayableCents: nra.cells.get("01-50") ?? 0 };
}
