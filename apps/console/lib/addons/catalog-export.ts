// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Resolves the whole marketplace catalog into the runner-facing install specs a deploy would
// actually install. Used by:
//   - scripts/export-addon-catalog.mts → test/e2e/fixtures/addon_catalog.json (the FULL add-on
//     surface the Go e2e harness seeds when ALETHIA_E2E_ALL_ADDONS=1);
//   - tests/lib/addons/catalog-export.test.ts, which reds CI if that fixture drifts from catalog.ts.
//
// It lives here (a normal module) rather than inside the script so the guard test can import it
// without reaching into a `.mts` entrypoint.

import { ADDON_CATALOG, resolveAddOnInstall } from "@/lib/addons/catalog";
import type { AddOnInstallSpec } from "@/lib/addons/types";

/** Every catalog add-on, resolved with its default knobs in managed mode, in a stable order. */
export function exportCatalogSpecs(): AddOnInstallSpec[] {
	const specs: AddOnInstallSpec[] = [];
	for (const def of ADDON_CATALOG) {
		const spec = resolveAddOnInstall({ addon_id: def.id, mode: "managed" });
		if (!spec) throw new Error(`catalog add-on ${def.id} failed to resolve`);
		specs.push(spec);
	}
	// Deterministic order so the generated fixture's diff is stable across regenerations.
	specs.sort((a, b) => a.id.localeCompare(b.id));
	return specs;
}
