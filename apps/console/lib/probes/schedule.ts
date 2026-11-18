// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Probe scheduling (BYOC B2 — the live cluster-alive signal). Picks which environments are
 * due for a `PROBE_CLUSTER` liveness dial, on a cadence tiered by criticality. Cloned from
 * the drift scheduler (lib/drift/schedule.ts) — same tier concept, same deterministic
 * selection — but with a MUCH tighter cadence: a probe is a cheap API-server dial (no tofu),
 * and a dead cluster must be noticed in minutes, not hours, so production is re-probed every
 * 10m (vs drift's 6h). Pure and deterministic: the sweeper (lib/probes/dispatch.ts) supplies
 * the candidates (each ACTIVE env + the timestamp of its last PROBE_CLUSTER job) and enqueues
 * a probe for the ones this returns.
 */

import { type DriftTier, tierForStage } from "@/lib/drift/schedule";

// The probe tier taxonomy is identical to drift's (prod/staging/dev) and the stage→tier
// mapping is shared verbatim (tierForStage) so the two schedulers never diverge on how an
// environment's stage picks its tier — only the cadence below differs.
export type ProbeTier = DriftTier;
export { tierForStage };

/**
 * Cadence per tier — production is re-probed most often. Deliberately far tighter than
 * DRIFT_CADENCE_MS: liveness is time-sensitive (a customer's cluster going dark should
 * surface in minutes) and a probe is cheap (a bounded API-server dial), unlike a
 * refresh-only tofu plan.
 */
export const PROBE_CADENCE_MS: Record<ProbeTier, number> = {
	prod: 10 * 60_000, // 10m
	staging: 60 * 60_000, // 1h
	dev: 6 * 3_600_000, // 6h
};

export interface ProbeCandidate {
	environmentId: string;
	projectId: string;
	tier: ProbeTier;
	/** When this env was last probed (null = never). */
	lastCheckedAt: Date | null;
	/** Whether the env is ACTIVE. Absent = ACTIVE (the only kind the sweep used to probe). */
	active?: boolean;
	/** Consecutive misses on its newest probes (failed jobs, or unreachable). Absent = 0. */
	misses?: number;
}

/** The longest a non-ACTIVE env waits between probes, however many it has missed. */
export const PROBE_BACKOFF_CAP_MS = 7 * 24 * 3_600_000;

/**
 * The interval before an env is probed again (#6736). An ACTIVE env keeps its tier cadence —
 * an outage there must surface in minutes. A non-ACTIVE env (in flight, FAILED, a plan over a live
 * cluster) is probed at the SAME tier cadence, never tighter, doubled for every consecutive miss
 * and capped at {@link PROBE_BACKOFF_CAP_MS}: a cluster that is gone or a probe that cannot run is
 * looked at less and less often instead of every interval for ever, which also bounds the runner
 * minutes and the failed-job alerts it costs.
 */
export function probeCadenceMs(tier: ProbeTier, active: boolean, misses: number): number {
	const base = PROBE_CADENCE_MS[tier];
	if (active || misses <= 0) return base;
	// 2^misses, computed without overflow: past ~20 doublings every tier is far beyond the cap.
	const factor = 2 ** Math.min(misses, 20);
	return Math.min(base * factor, PROBE_BACKOFF_CAP_MS);
}

/** Consecutive misses at the head of an env's probe history (newest first): stops at the first hit. */
export function countLeadingMisses(newestFirst: readonly { hit: boolean }[]): number {
	let n = 0;
	for (const p of newestFirst) {
		if (p.hit) break;
		n += 1;
	}
	return n;
}

/**
 * Returns the candidates whose last probe is older than their cadence (or that have never been
 * probed). Deterministic given `now`. Mirrors `selectDueForDrift`, keyed off
 * {@link probeCadenceMs} — the tier cadence, backed off for a non-ACTIVE env that keeps missing.
 */
export function selectDueForProbe(
	candidates: ProbeCandidate[],
	now: Date,
): ProbeCandidate[] {
	return candidates.filter((c) => {
		if (c.lastCheckedAt === null) return true;
		const cadence = probeCadenceMs(c.tier, c.active ?? true, c.misses ?? 0);
		return now.getTime() - c.lastCheckedAt.getTime() >= cadence;
	});
}

/**
 * The core liveness-alert predicate: alert ONLY on a true→false transition — a cluster that
 * WAS reachable and now ISN'T. Pure + exhaustively unit-tested so the alerting policy is
 * unambiguous:
 *   • true  → false  ⇒ ALERT (the cluster just went dark)
 *   • null  → false  ⇒ no alert (first-ever probe already unreachable — never proven alive;
 *                       a fresh/never-deployed env shouldn't page; the deploy path owns that)
 *   • false → false  ⇒ no alert (still down; already alerted on the transition — no re-page)
 *   • true  → true   ⇒ no alert (healthy)
 *   • false → true   ⇒ no alert here (that's a RECOVERY, not an outage)
 *   • null  → true   ⇒ no alert (first probe, healthy)
 */
export function shouldAlertUnreachable(
	prevReachable: boolean | null,
	nextReachable: boolean,
): boolean {
	return prevReachable === true && nextReachable === false;
}
