// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The config snapshot's `byo_admission` (#6541): the environment's setting, and the console's half of
// what decides a bring-your-own namespace's admission mode on the runner (Go `argocd.DecideByoAdmission`).
//
// THE RUNNER DECIDES FROM THE CLUSTER. It reads each chart's live ArgoCD Application on every deploy,
// and only an Application that already deploys into the chart's namespace lets the chart into an
// existing namespace that is not this environment's. What this file sends is a SECOND, weaker signal
// that only ever chooses `warn` over `enforce` for a namespace that is new or already this
// environment's own — the case the cluster can no longer answer, a re-provisioned cluster with no
// Applications. The runner never lets it lift a refusal.
//
// WHAT COUNTS AS "HAS RUN". A chart whose last ArgoCD read-back (`project_addons.health`, written by
// recordAddonHealth after a deploy or a drift scan) is a state in which the Application exists AND has
// resources: Healthy, Progressing, Degraded or Suspended. NOT `last_synced_at`: that is stamped for
// every name the runner asked about, and the runner's health read seeds `Unknown/Unknown` for a name
// before it reads anything, so it is set for an Application that does not exist, for a chart the
// deploy refused, and for every name when the read failed. `Unknown` is exactly those cases, and
// `Missing` is an Application whose resources do not exist, so neither counts. `last_synced_at` and
// its other readers (the CLI add-ons list) are left as they are.
//
// NO BACKFILL. `health` is written by the same read-back that has always run, so every chart that has
// been read back in a running state already carries it. A chart whose LAST read was Unknown (a kubectl
// hiccup) is not listed until its next good read; for a namespace that still exists that changes
// nothing, because the runner's own Application read decides there.
//
// Emitted ONLY when the environment has a BYO chart, so every other environment freezes the same
// snapshot bytes as before. Gated on the runner capability `byo-admission`
// (lib/runners/snapshot-capabilities.ts), and stripped for a runner without it.

/**
 * The snapshot's `byo_admission` — Go `types.ByoAdmissionConfig`. Its wire shape is pinned on both
 * sides by the shared fixture `with-byo-admission.json` (packages/core/types/testdata).
 */
export interface ByoAdmissionSnapshot {
	/** The environment's setting (project_environments.byo_admission_enforce). */
	enforce: boolean;
	/** The ids of the BYO charts last read back in a running state, sorted. */
	deployed_charts: string[];
}

/** The slice of a project_addons row this reads. */
export interface ByoAdmissionAddonRow {
	source: string;
	addon_id: string;
	health: string | null;
}

/** ArgoCD health states in which an Application exists and has resources: the chart has run. */
const RAN_HEALTH: ReadonlySet<string> = new Set(["Healthy", "Progressing", "Degraded", "Suspended"]);

/**
 * The `byo_admission` value for an environment whose setting is `enforce` and whose enabled add-on
 * rows are `rows`, or `null` when it has no BYO chart (the key is then left off the snapshot).
 */
export function byoAdmissionSnapshot(
	enforce: boolean,
	rows: readonly ByoAdmissionAddonRow[],
): ByoAdmissionSnapshot | null {
	const byo = rows.filter((r) => r.source === "byo");
	if (byo.length === 0) return null;
	return {
		enforce,
		deployed_charts: byo
			.filter((r) => r.health !== null && RAN_HEALTH.has(r.health))
			.map((r) => r.addon_id)
			.sort(),
	};
}
