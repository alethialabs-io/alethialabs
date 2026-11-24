// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The `nra/` folder of the accountant's export: @repo/nra's package for the month, built from the
// console's own documents (facturi-M.json, sales-documents.ts) and the operator's input file, with
// each protocol rendered by the console's PDF renderer. The export lists every file in
// MANIFEST.sha256. `nra:build` (scripts/nra-build.ts) builds the same package from the JSON files
// alone; both go through buildNraPackage, so they cannot disagree.

import { buildNraPackage, type NraInput, type ProtocolRenderer, type SalesFile } from "@repo/nra";
import type { ExportFile } from "@/lib/billing/factura/export";

/** The `nra/` files for a month, or the problems that stop them. */
export type NraExport =
	| { ok: true; files: ExportFile[]; vatPayableCents: number; vatRefundableCents: number }
	| { ok: false; problems: string[] };

/** The month's NRA package placed under `nra/`. Refuses with problems, never a partial set. */
export async function buildNraExport(
	sales: SalesFile,
	input: NraInput,
	render: ProtocolRenderer,
	options: { demo: boolean },
): Promise<NraExport> {
	const pkg = await buildNraPackage(sales, input, render, options);
	if (!pkg.ok) return pkg;
	return {
		ok: true,
		files: pkg.files.map((f) => ({ name: `nra/${f.name}`, data: f.data })),
		vatPayableCents: pkg.cells.get("01-50") ?? 0,
		vatRefundableCents: pkg.cells.get("01-60") ?? 0,
	};
}
