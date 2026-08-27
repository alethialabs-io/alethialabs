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

/**
 * A stand-in for "this secret key has a stored value".
 *
 * `resolveAddOnInstall` decides whether to emit a `secretRef` by asking `hasStoredSecret` which keys
 * are PRESENT — it never reads the value, because a secret knob is stripped before validation and can
 * never reach the rendered values. So a marker is enough to make the resolver take the stored-secret
 * branch, and NOTHING derived from it is emitted: a `secretRef` carries the Secret's name, namespace,
 * data KEY NAMES and the non-secret staticData, and no credential at any point.
 *
 * A guard test asserts this string does not appear in the generated fixture.
 */
// NOT named *_SECRET_*: gitleaks' `generic-api-key` rule matches on the NAME, and flagged this
// constant — whose entire job is to prove no secret reaches the output — as a leaked credential.
// Renaming is the fix rather than an allowlist entry: an allowlist would put a permanent hole in
// the one check that would catch a real value landing in exactly this file.
const PRESENCE_MARKER = "e2e-fixture-presence-marker";

/** Every catalog add-on, resolved with its default knobs in managed mode, in a stable order. */
export function exportCatalogSpecs(): AddOnInstallSpec[] {
	const specs: AddOnInstallSpec[] = [];
	for (const def of ADDON_CATALOG) {
		// An add-on that MINTS its own secrets at enable time (#2822) is resolved as if those
		// secrets were already stored, so the exported spec carries the `secretRef` the runner needs
		// to seed the in-cluster Secret. Without this the fixture describes an add-on that was never
		// enabled through the console — no secretRef, so `EnsureAddOnSecrets` skips it, so the chart
		// falls back to generating its own credential at RENDER time, which differs on every
		// reconcile. #2835.
		const minted = def.generateSecrets
			? Object.keys(def.generateSecrets(new Set<string>()))
			: [];
		const values = Object.fromEntries(
			minted.map((key) => [key, PRESENCE_MARKER]),
		);
		const spec = resolveAddOnInstall({
			addon_id: def.id,
			mode: "managed",
			...(minted.length > 0 ? { values } : {}),
		});
		if (!spec) throw new Error(`catalog add-on ${def.id} failed to resolve`);
		specs.push(spec);
	}
	// Deterministic order so the generated fixture's diff is stable across regenerations.
	specs.sort((a, b) => a.id.localeCompare(b.id));
	return specs;
}
