// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Which config_snapshot keys a runner can decode, and the snapshot served to one that cannot.
//
// The runner decodes `config_snapshot` STRICTLY (apps/runner assertNoUnknownSnapshotKeys, #1973) —
// down into `addons[]` — so a key it has no field for fails the job outright. A runner built before a
// key existed must therefore never be served it. Each new key is tied to a capability the runner names
// on every request in the `X-Runner-Capabilities` header (Go: types.RunnerCapabilitiesHeader /
// RunnerSnapshotCapabilities); a runner that names none — every runner built before the header — is
// served the snapshot exactly as it was before the key.
//
// Applied at CLAIM, to the copy in the response: the stored snapshot, and the signature verified over
// it, are unchanged. The two halves are pinned by the shared fixtures in
// packages/core/types/testdata/snapshot-capabilities (this side's test, and the runner's
// snapshot_capabilities_test.go, which decodes the stripped one the way an old runner does).

/** The request header a runner lists its capabilities in. Mirrors Go `types.RunnerCapabilitiesHeader`. */
export const RUNNER_CAPABILITIES_HEADER = "X-Runner-Capabilities";

/** The runner reads `addons[].byo` (#6445). Mirrors Go `types.RunnerCapabilityAddonByoMarker`. */
export const RUNNER_CAPABILITY_ADDON_BYO_MARKER = "addon-byo-marker";

/** The capabilities a runner advertised, from its header value (`null` when it sent none). */
export function parseRunnerCapabilities(header: string | null): ReadonlySet<string> {
	if (!header) return new Set();
	return new Set(
		header
			.split(",")
			.map((c) => c.trim())
			.filter(Boolean),
	);
}

/**
 * The snapshot to serve a runner with `capabilities`: `snapshot` itself when it can read every key,
 * otherwise a copy without the keys it cannot. Today that is `addons[].byo` alone. Never mutates the
 * input.
 */
export function snapshotForRunner(
	snapshot: Record<string, unknown>,
	capabilities: ReadonlySet<string>,
): Record<string, unknown> {
	if (capabilities.has(RUNNER_CAPABILITY_ADDON_BYO_MARKER)) return snapshot;
	const addons = snapshot.addons;
	if (!Array.isArray(addons)) return snapshot;
	if (!addons.some((a) => a !== null && typeof a === "object" && "byo" in a)) return snapshot;
	return {
		...snapshot,
		addons: addons.map((a: unknown) => {
			if (a === null || typeof a !== "object" || !("byo" in a)) return a;
			return Object.fromEntries(Object.entries(a).filter(([key]) => key !== "byo"));
		}),
	};
}
