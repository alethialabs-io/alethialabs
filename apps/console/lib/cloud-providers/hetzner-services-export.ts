// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Resolves the Hetzner data-service components the Go E2E max-config surface seeds into the
// runner-facing install specs a REAL deploy would carry — the same
// `hetznerDataServicesToAddOns(...)` call `buildConfigSnapshot` makes for a Hetzner project
// (apps/console/app/server/actions/projects.ts). Used by:
//
//   - scripts/export-hetzner-data-services.mts → test/e2e/fixtures/hetzner_data_services.json,
//     which the Go harness appends to the DEPLOY snapshot's `addons` on a Hetzner max-config run
//     (test/e2e/hetzner_data_services.go);
//   - tests/lib/cloud-providers/hetzner-data-services-export.test.ts, which reds CI if that fixture
//     drifts from this module.
//
// WHY THIS EXISTS AT ALL. Hetzner's `database`/`cache`/`queue` are `CarriedInCluster` in the
// max-config table: nothing lands in tofu state, and the proof is the named ArgoCD Application
// reaching Healthy+Synced. But the runner only renders an Application for an add-on that RIDES THE
// SNAPSHOT, and the Go harness seeds add-ons from the marketplace catalog alone — which never holds
// the Hetzner data services, because they are synthesized per component, not chosen from a
// marketplace. So those three cells asserted an Application that could not exist, and a Hetzner
// full-bar run was red by construction.
//
// Re-typing the mapping in Go would fix the run and create the drift this repo forbids (the mapper
// owns chart coordinates, namespaces, sync-waves, the CNPG CRD gate, and value schemas that have
// each broken in production once already — see hetzner-services.ts). So the fixture is DERIVED
// through the real mapper on the same rail `addon_catalog.json` already uses, and the drift guard
// makes a stale one a red CI check rather than a red nightly against a real cloud.
//
// It lives here (a normal module) rather than inside the `.mts` script so the guard test can import
// it — exactly the reason lib/addons/catalog-export.ts does.

import type { AddOnInstallSpec } from "@/lib/addons/types";
import { hetznerDataServicesToAddOns } from "@/lib/cloud-providers/hetzner-services";

/**
 * The data components the Go max-config surface seeds on Hetzner, in the row shape
 * `hetznerDataServicesToAddOns` consumes.
 *
 * These MIRROR `MaxConfigKinds`' database/cache/queue Apply on the hetzner column
 * (test/e2e/maxconfig.go) — and the mirror is not trusted: `TestHetznerDataServiceFixtureMatchesTheMaxConfigSurface`
 * reads this block back out of the generated fixture and compares it field-by-field with the REAL
 * `MaxConfigProjectConfig("hetzner")`, on every PR. A rename or a version bump on either side reds
 * that free test instead of installing a chart for a component the deploy never declared.
 *
 * Only the fields the mapper reads are declared; the Go surface carries more (ports, retention,
 * multi-AZ) and the mapper ignores every one of them.
 */
export const E2E_MAX_CONFIG_HETZNER_COMPONENTS = {
	databases: [
		{ name: "appdb", engine_family: "postgres", engine_version: "16" },
	],
	caches: [{ name: "sessions", num_cache_nodes: 2 }],
	queues: [{ name: "jobs" }],
} as const;

/** The generated fixture's shape: the components that were mapped, and what they mapped to. */
export interface HetznerDataServiceFixture {
	/** The input rows — read back by the Go guard against the real max-config ProjectConfig. */
	components: {
		databases: { name: string; engine_family: string; engine_version: string }[];
		caches: { name: string; num_cache_nodes: number }[];
		queues: { name: string }[];
	};
	/** The install specs a Hetzner deploy of those components would carry. */
	addons: AddOnInstallSpec[];
}

/**
 * Builds the fixture: the declared components plus the specs the REAL mapper produces for them.
 * Structured-cloned through JSON so the `as const` readonly literals become plain mutable data
 * (what both the writer and the equality guard compare).
 */
export function exportHetznerDataServiceFixture(): HetznerDataServiceFixture {
	const components = JSON.parse(
		JSON.stringify(E2E_MAX_CONFIG_HETZNER_COMPONENTS),
	) as HetznerDataServiceFixture["components"];
	return { components, addons: hetznerDataServicesToAddOns(components) };
}
