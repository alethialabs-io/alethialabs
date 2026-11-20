// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// No "use client" and no server imports: the clusters table and its detail (client) and the
// clusters page's server half (`lib/queries/clusters.ts`, which filters on the posture) both read
// this module, so the status a row shows and the status a filter selects are one derivation.

import { type StatusTier, statusTier } from "@repo/ui/status-badge";
import type { ControlPlaneObservation } from "@/lib/clusters/observed-state";
import { IN_FLIGHT } from "@/lib/copy/vocabulary";

/** Title-cases a SCREAMING_CASE component status ("UPDATING" → "Updating"). */
export function humanize(status: string): string {
	return status.charAt(0) + status.slice(1).toLowerCase();
}

/** Component-health tally over the cluster + its data services. */
export interface ComponentHealth {
	total: number;
	healthy: number;
	failed: number;
	pending: number;
}

/** A cluster's derived posture. */
export interface Posture {
	tier: StatusTier;
	/** Posture shown next to the cluster's name (what an operator scans). */
	name: string;
	/** Short rollup label. */
	rollup: string;
	/** The rollup badge's tier — the last run's outcome, which can differ from the cluster's. */
	rollupTier: StatusTier;
	/** Secondary detail under the rollup. */
	detail: string;
	health: ComponentHealth;
}

/** What the console has observed of the control plane, and since when the environment's status holds. */
export interface Observed {
	observation: ControlPlaneObservation;
	/** When the environment's status was last written (ISO). */
	statusSince: string;
}

/** No contradicting reading and a fresh one: what a caller that passes no observation means. */
const OBSERVED_FRESH: Observed = {
	observation: { kind: "reported", observedAt: null, source: "deploy", fresh: true },
	statusSince: new Date(0).toISOString(),
};

/**
 * The control plane's own badge: what was recorded, unless something observed since says otherwise.
 * A drift scan reporting it deleted reads "Missing"; a probe that could not reach it "Unreachable";
 * and an "Active" no reading has backed recently reads "Unverified" — the console has no fresh
 * evidence for it, so it does not repeat it (#6736).
 */
export function controlPlaneBadge(
	clusterStatus: string,
	observation: ControlPlaneObservation,
): { tier: StatusTier; label: string } {
	if (observation.kind === "missing") return { tier: "failed", label: "Missing" };
	if (observation.kind === "unreachable") return { tier: "failed", label: "Unreachable" };
	const tier = statusTier(clusterStatus);
	if (tier === "active" && !observation.fresh) return { tier: "idle", label: "Unverified" };
	return { tier, label: humanize(clusterStatus) };
}

/**
 * Rolls the cluster's own status and every database/cache status into a single posture, then lets
 * the ENVIRONMENT's lifecycle speak to what is happening to it. Every row is a cluster under
 * management — its environment has a live deployment (lib/queries/usage-counts.ts) — so:
 *   · a control plane a drift scan reports deleted reads as missing — unless a run started after
 *     that scan, which is then what is happening to it;
 *   · a run in flight (queued, deploying, destroying) reads as in flight;
 *   · a failed last run (a plan, a redeploy, a destroy) does NOT make a running cluster "Failed":
 *     the cluster keeps the posture its rows report, and the rollup says the last run failed;
 *   · otherwise a failed data service reads as degraded and a reconcile as reconciling;
 *   · and a control plane nothing has observed recently is never counted healthy (#6736).
 * The badge is DERIVED, never hardcoded.
 */
export function deriveHealth(
	clusterStatus: string,
	envStatus: string,
	componentStatuses: string[],
	observed: Observed = OBSERVED_FRESH,
): Posture {
	const { observation } = observed;
	const cp = controlPlaneBadge(clusterStatus, observation);
	const tiers = [cp.tier, ...componentStatuses.map((s) => statusTier(s))];
	const total = tiers.length;
	const healthy = tiers.filter((t) => t === "active").length;
	const failed = tiers.filter((t) => t === "failed").length;
	const pending = tiers.filter((t) => t === "pending").length;
	const health: ComponentHealth = { total, healthy, failed, pending };
	const detail = `${healthy} / ${total} healthy`;

	const envTier = statusTier(envStatus);
	const runAfterScan =
		observation.kind === "missing" && Date.parse(observed.statusSince) > Date.parse(observation.observedAt);
	if (observation.kind === "missing" && !(envTier === "pending" && runAfterScan)) {
		return { tier: "failed", name: "Missing", rollup: "Deleted outside Alethia", rollupTier: "failed", detail, health };
	}
	if (envTier === "pending") {
		return {
			tier: "pending",
			name: inFlightLabel(envStatus),
			rollup: inFlightLabel(envStatus),
			rollupTier: "pending",
			detail,
			health,
		};
	}
	const posture = rowPosture(clusterStatus, cp, health, detail);
	return envTier === "failed" ? { ...posture, rollup: "Last run failed", rollupTier: "failed" } : posture;
}

/** An in-flight environment status in the console's vocabulary: Queued, Deploying, Destroying. */
export function inFlightLabel(envStatus: string): string {
	if (envStatus === "PROVISIONING") return IN_FLIGHT.deploy;
	if (envStatus === "DESTROYING") return IN_FLIGHT.destroy;
	if (envStatus === "QUEUED") return IN_FLIGHT.queued;
	return humanize(envStatus);
}

/** The posture the cluster's own rows report, with no run in flight. */
function rowPosture(
	clusterStatus: string,
	cp: { tier: StatusTier; label: string },
	health: ComponentHealth,
	detail: string,
): Posture {
	const { total, healthy, failed, pending } = health;
	if (cp.tier === "failed" && cp.label === "Unreachable") {
		return { tier: "failed", name: "Unreachable", rollup: "Unreachable", rollupTier: "failed", detail, health };
	}
	if (failed > 0) {
		return { tier: "failed", name: "Degraded", rollup: `${failed} failed`, rollupTier: "failed", detail, health };
	}
	if (pending > 0) {
		// Surface the control plane's own in-flight verb when it's the one moving.
		const name = cp.tier === "pending" ? humanize(clusterStatus) : "Reconciling";
		return { tier: "pending", name, rollup: "Reconciling", rollupTier: "pending", detail, health };
	}
	if (healthy === total) {
		return { tier: "active", name: "Active", rollup: "Healthy", rollupTier: "active", detail, health };
	}
	if (cp.label === "Unverified") {
		return { tier: "idle", name: "Unverified", rollup: "Not observed recently", rollupTier: "idle", detail, health };
	}
	return { tier: cp.tier, name: cp.label, rollup: cp.label, rollupTier: cp.tier, detail, health };
}

/** The fields of a cluster row its posture is derived from. */
export interface PostureFacts {
	/** The owning environment's lifecycle (`project_environments.status`). */
	status: string;
	/** When that status was last written (ISO). */
	status_since: string;
	project_cluster: { status: string; observation: ControlPlaneObservation };
	project_databases: readonly { status: string }[];
	project_caches: readonly { status: string }[];
}

/** One cluster row's posture — {@link deriveHealth} over the row's own fields. */
export function clusterPosture(row: PostureFacts): Posture {
	return deriveHealth(
		row.project_cluster.status,
		row.status,
		[...row.project_databases.map((d) => d.status), ...row.project_caches.map((c) => c.status)],
		{ observation: row.project_cluster.observation, statusSince: row.status_since },
	);
}

/**
 * The status a cluster is FILTERED under — one of four, so the filter bar's chips are a fixed row:
 * `failed` (needs attention: missing, unreachable, degraded, or a failed last run), `pending` (a run
 * or a reconcile in flight), `active` (healthy), and `idle` (anything nothing has confirmed).
 */
export type ClusterStatusKey = "failed" | "pending" | "active" | "idle";

/** The four filter statuses, in the order the bar shows them. */
export const CLUSTER_STATUS_KEYS: readonly ClusterStatusKey[] = ["failed", "pending", "active", "idle"];

/** The filter status of a posture. A failed last run over a running cluster is `failed`. */
export function clusterStatusKey(posture: Posture): ClusterStatusKey {
	if (posture.tier === "failed" || posture.rollupTier === "failed") return "failed";
	if (posture.tier === "pending" || posture.tier === "live") return "pending";
	if (posture.tier === "active") return "active";
	return "idle";
}

/** Whether the environment's run is in flight (queued, deploying, destroying). */
export function runInFlight(envStatus: string): boolean {
	return statusTier(envStatus) === "pending";
}

/**
 * Whether a cluster's record offers the missing-cluster actions: the control plane is observed
 * missing, its environment is known, and no run is in flight on it — a run in flight will write its
 * own outcome, and the mark would be refused while it runs.
 */
export function offersMissingActions(row: {
	status: string;
	environment_id: string | null;
	project_cluster: { observation: ControlPlaneObservation };
}): boolean {
	return (
		row.project_cluster.observation.kind === "missing" && row.environment_id !== null && !runInFlight(row.status)
	);
}
