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
// WHAT COUNTS AS "HAS RUN". A chart whose ArgoCD read-back (recordAddonHealth, after a deploy or a
// drift scan) has EVER seen its Application in a state with resources — Healthy, Progressing,
// Degraded or Suspended — which stamps `project_addons.first_observed_running_at` once and never
// clears it. NOT the current `health`: a drift scan rewrites that to Unknown for an Application it
// cannot find, which is exactly what a re-provisioned cluster looks like, and the history would be
// gone when it is needed. And NOT `last_synced_at`: that is stamped for every name the runner asked
// about, and the runner's health read seeds `Unknown/Unknown` for a name before it reads anything,
// so it is set for an Application that does not exist, for a chart the deploy refused, and for every
// name when the read failed. `Unknown` and `Missing` (an Application whose resources do not exist)
// never stamp the column.
//
// BACKFILL. The column's migration (0173) stamps every existing row whose current health is a running
// state, so a chart that ran before the column existed keeps its history.
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
	/** The ids of the BYO charts ever read back in a running state, sorted. */
	deployed_charts: string[];
}

/** The slice of a project_addons row this reads. */
export interface ByoAdmissionAddonRow {
	source: string;
	addon_id: string;
	first_observed_running_at: Date | null;
}

/** ArgoCD health states in which an Application exists and has resources: the chart has run. */
const RAN_HEALTH: ReadonlySet<string> = new Set(["Healthy", "Progressing", "Degraded", "Suspended"]);

/** Whether an ArgoCD health read-back is a running state (RAN_HEALTH) — what stamps the history. */
export function isRunningHealth(health: string | null | undefined): boolean {
	return health !== null && health !== undefined && RAN_HEALTH.has(health);
}

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
			.filter((r) => r.first_observed_running_at !== null)
			.map((r) => r.addon_id)
			.sort(),
	};
}
