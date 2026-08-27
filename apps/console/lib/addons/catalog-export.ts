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
import type { ExternalDnsProvider } from "@/lib/addons/catalog";
import type { AddOnInstallSpec } from "@/lib/addons/types";
import type { CloudProvider } from "@/lib/cloud-providers/connections";

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

/**
 * The external-dns provider each cloud manages its OWN DNS with, or `null` where the catalog offers
 * none for it.
 *
 * A total `Record<CloudProvider, …>` on purpose, mirroring `EXTERNAL_DNS_PROVIDERS` in catalog.ts:
 * adding a cloud without deciding this is a COMPILE error, so the offer and the fixture cannot
 * drift apart the way they just did.
 *
 * WHY THIS EXISTS. `provider` defaults to `cloudflare` (catalog.ts), which is right for a console
 * user picking a provider and wrong for the e2e full-add-on sweep: it installs external-dns pointed
 * at Cloudflare, on every cloud, with no Cloudflare token. It cannot converge and never could, so
 * that cell was not measuring the chart at all (#2717 class (c)).
 *
 * `null` is a recorded FACT, not a gap in this map: EXTERNAL_DNS_PROVIDER_IDS has no alibaba and no
 * civo entry, so there is nothing native to point them at. Those fixtures keep the catalog default,
 * exactly as today — this change does not make them worse, and it must not pretend to make them
 * better. Neither is in the current 24-cell parity target.
 */
const EXTERNAL_DNS_NATIVE_PROVIDER: Record<CloudProvider, ExternalDnsProvider | null> = {
	aws: "aws",
	gcp: "google",
	azure: "azure",
	hetzner: "hetzner",
	digitalocean: "digitalocean",
	alibaba: null,
	civo: null,
};

/** The clouds a fixture is generated for — the e2e nightly's provider matrix. */
export const EXPORT_CLOUDS = ["aws", "gcp", "azure", "alibaba", "hetzner"] as const satisfies readonly CloudProvider[];

/**
 * Knobs that depend on the TARGET CLOUD rather than on the add-on alone.
 *
 * Returned as plain knob values and fed through the real `resolveAddOnInstall`, so the shapes the
 * emitter derives from them — the webhook sidecar for hetzner, the `saAnnotation` for the
 * workload-identity providers — come out of the emitter and are never restated here. That is the
 * whole reason this lives in TypeScript beside the catalog instead of in the Go harness.
 */
function cloudKnobs(addonId: string, cloud: CloudProvider): Record<string, unknown> {
	if (addonId !== "external-dns") return {};
	const native = EXTERNAL_DNS_NATIVE_PROVIDER[cloud];
	return native === null ? {} : { provider: native };
}

/** Every catalog add-on, resolved with its default knobs in managed mode, in a stable order. */
export function exportCatalogSpecs(cloud: CloudProvider): AddOnInstallSpec[] {
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
		const values = {
			...Object.fromEntries(minted.map((key) => [key, PRESENCE_MARKER])),
			...cloudKnobs(def.id, cloud),
		};
		const spec = resolveAddOnInstall({
			addon_id: def.id,
			mode: "managed",
			...(Object.keys(values).length > 0 ? { values } : {}),
		});
		if (!spec) throw new Error(`catalog add-on ${def.id} failed to resolve for ${cloud}`);
		specs.push(spec);
	}
	// Deterministic order so the generated fixture's diff is stable across regenerations.
	specs.sort((a, b) => a.id.localeCompare(b.id));
	return specs;
}
