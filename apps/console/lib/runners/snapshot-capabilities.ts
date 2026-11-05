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
// One case is refused instead of stripped — a DEPLOY holding an OCI BYO chart — see refusalForRunner.
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

/** The ids of the add-ons in `snapshot` that are OCI bring-your-own charts: marked `byo`, not git. */
export function ociByoAddOnIds(snapshot: Record<string, unknown>): string[] {
	const addons = snapshot.addons;
	if (!Array.isArray(addons)) return [];
	const out: string[] = [];
	for (const a of addons) {
		if (a === null || typeof a !== "object") continue;
		const entries = new Map(Object.entries(a));
		if (entries.get("byo") === true && entries.get("source") !== "git") {
			const id = entries.get("id");
			out.push(typeof id === "string" ? id : "");
		}
	}
	return out;
}

/** The job types whose runner deploys add-ons from the snapshot — the ones the BYO marker matters to. */
const ADDON_DEPLOYING_JOB_TYPES: ReadonlySet<string> = new Set(["DEPLOY"]);

/**
 * Why this job must NOT be served to a runner with `capabilities`, or `null` when it may be.
 *
 * FAIL CLOSED, for one case. Stripping `byo` is safe when every BYO chart in the snapshot is a git
 * source: a runner without the capability still recognises those as BYO by their source and pins
 * them to the hardened project. An OCI BYO chart has no such signal — to that runner it is a plain
 * Helm add-on, rendered under the catalogue's project with no namespace check — and on a cluster a
 * newer runner already migrated, its re-apply would move the Application back. So a DEPLOY whose
 * snapshot holds an OCI BYO chart is refused to such a runner, with the fix in the reason, rather
 * than served stripped. Failing it (not leaving it queued) is deliberate: with no capable runner in
 * the pool, a queued job would wait forever, saying nothing. The cost is in a MIXED pool during a
 * rollout: claim_next_job has already assigned the row when this runs, so an older runner can fail a
 * deploy a newer one could have run, and the user deploys again. Skipping such rows inside
 * claim_next_job needs a migration; it is a follow-up. The claim route fails the job through
 * recordJobFailed, so the environment, the promotion and the alert follow as for any failure.
 */
export function refusalForRunner(
	jobType: string,
	snapshot: Record<string, unknown>,
	capabilities: ReadonlySet<string>,
): string | null {
	if (capabilities.has(RUNNER_CAPABILITY_ADDON_BYO_MARKER) || !ADDON_DEPLOYING_JOB_TYPES.has(jobType)) {
		return null;
	}
	const oci = ociByoAddOnIds(snapshot);
	if (oci.length === 0) return null;
	const named = oci.filter(Boolean).map((id) => `“${id}”`).join(", ");
	return `This project deploys a bring-your-own OCI chart${named ? ` (${named})` : ""}, which needs a runner newer than runner-v0.8.0 — one that reads the BYO chart marker (it sends the ${RUNNER_CAPABILITY_ADDON_BYO_MARKER} capability). Update the runner, then deploy again.`;
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
