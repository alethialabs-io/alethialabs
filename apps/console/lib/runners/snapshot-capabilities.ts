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

/**
 * The runner reads the top-level `preview_namespace_prefix` (#6494). Mirrors Go
 * `types.RunnerCapabilityPreviewNamespacePrefix`. Stripped, never refused: the key only feeds a
 * Deploy-tab warning, so an older runner deploys exactly as before, minus that warning.
 */
export const RUNNER_CAPABILITY_PREVIEW_NAMESPACE_PREFIX = "preview-namespace-prefix";

/** The top-level snapshot key {@link RUNNER_CAPABILITY_PREVIEW_NAMESPACE_PREFIX} gates. */
const PREVIEW_NAMESPACE_PREFIX_KEY = "preview_namespace_prefix";

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
 * than served stripped.
 *
 * Most such jobs never reach this check (#6458). The claim route passes the runner's capabilities into
 * claim_next_job, which stamps them on runners.capabilities and leaves a job needing one the runner
 * lacks QUEUED while a LIVE (heartbeating and claiming) runner in the job's pool advertises it — so
 * in a MIXED pool during a rollout the newer runner takes it, however long other gates hold the job.
 * The SQL half of this rule is `job_required_capabilities` in lib/db/programmables.sql (stored on jobs.required_capabilities by a
 * trigger), pinned to this one over the shared fixtures by
 * tests/integration/claim-capability-skip.test.ts. When NO live runner in the pool has the capability,
 * nobody else could run the job, so the incapable runner is handed it and this check fails it: a job
 * no runner can run does not wait forever, saying nothing. This check also still fails an ASSIGNED
 * job at once (no other runner may claim it), and stays as the defence should the SQL reading ever
 * disagree with this one. The claim route fails the job through
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
 * otherwise a copy without the keys it cannot — `addons[].byo` and the top-level
 * `preview_namespace_prefix`, each gated by its own capability. Never mutates the input.
 */
export function snapshotForRunner(
	snapshot: Record<string, unknown>,
	capabilities: ReadonlySet<string>,
): Record<string, unknown> {
	return withoutByoMarker(withoutPreviewNamespacePrefix(snapshot, capabilities), capabilities);
}

/** `snapshot` without the top-level `preview_namespace_prefix` unless the runner reads it (#6494). */
function withoutPreviewNamespacePrefix(
	snapshot: Record<string, unknown>,
	capabilities: ReadonlySet<string>,
): Record<string, unknown> {
	if (capabilities.has(RUNNER_CAPABILITY_PREVIEW_NAMESPACE_PREFIX)) return snapshot;
	if (!(PREVIEW_NAMESPACE_PREFIX_KEY in snapshot)) return snapshot;
	return Object.fromEntries(Object.entries(snapshot).filter(([key]) => key !== PREVIEW_NAMESPACE_PREFIX_KEY));
}

/** `snapshot` without `addons[].byo` unless the runner reads it (#6445). */
function withoutByoMarker(
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
