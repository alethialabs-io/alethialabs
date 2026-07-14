// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Exports EVERY marketplace add-on, resolved through the real `resolveAddOnInstall`, to
// `test/e2e/fixtures/addon_catalog.json` — the runner-facing `AddOnInstallSpec[]` the Go e2e
// harness seeds when it exercises the FULL add-on surface (all 19 charts, not just the one lean
// seed).
//
// Why a generated fixture rather than a hand-written Go table: `catalog.ts` is the SSOT for chart
// coordinates. Re-typing them in Go would silently drift the moment someone bumps a chart (and the
// drift would only surface as a red nightly against a real cloud). Here the fixture is DERIVED, and
// `catalog-export.test.ts` fails CI if it is stale — so a chart bump forces a regeneration.
//
// Usage: pnpm -F console export:addon-catalog

import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ADDON_CATALOG, resolveAddOnInstall } from "../lib/addons/catalog.js";
import type { AddOnInstallSpec } from "../lib/addons/types.js";

/** Resolves every catalog add-on with its default knobs, in managed mode (what a deploy installs). */
export function exportCatalogSpecs(): AddOnInstallSpec[] {
	const specs: AddOnInstallSpec[] = [];
	for (const def of ADDON_CATALOG) {
		const spec = resolveAddOnInstall({ addon_id: def.id, mode: "managed" });
		if (!spec) throw new Error(`catalog add-on ${def.id} failed to resolve`);
		specs.push(spec);
	}
	// Deterministic order so the fixture diff is stable across regenerations.
	specs.sort((a, b) => a.id.localeCompare(b.id));
	return specs;
}

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../../../test/e2e/fixtures/addon_catalog.json");
const specs = exportCatalogSpecs();
writeFileSync(out, `${JSON.stringify(specs, null, "\t")}\n`);
console.log(`wrote ${specs.length} add-on specs → ${out}`);
