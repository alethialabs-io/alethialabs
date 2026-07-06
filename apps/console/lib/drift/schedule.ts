// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Drift scheduling (elench). Picks which environments are due for a refresh-only
 * drift check, on a cadence tiered by criticality so the provider-API cost stays
 * bounded. Pure and deterministic — the cron route (app/api/cron/drift) supplies
 * the candidates (each env + the timestamp of its last DETECT_DRIFT job) and enqueues
 * `detectDrift` for the ones this returns.
 */

export type DriftTier = "prod" | "staging" | "dev";

/** Cadence per tier — production is rechecked most often. */
export const DRIFT_CADENCE_MS: Record<DriftTier, number> = {
	prod: 6 * 3_600_000, // 6h
	staging: 24 * 3_600_000, // 1d
	dev: 7 * 24 * 3_600_000, // 7d
};

export interface DriftCandidate {
	environmentId: string;
	projectId: string;
	tier: DriftTier;
	/** When this env was last drift-checked (null = never). */
	lastCheckedAt: Date | null;
}

/** Map an environment stage string onto a cadence tier. */
export function tierForStage(stage: string | null | undefined): DriftTier {
	const s = (stage ?? "").toLowerCase();
	if (s === "production" || s === "prod") return "prod";
	if (s === "staging" || s === "stage") return "staging";
	return "dev";
}

/**
 * Returns the candidates whose last drift check is older than their tier's cadence
 * (or that have never been checked). Deterministic given `now`.
 */
export function selectDueForDrift(
	candidates: DriftCandidate[],
	now: Date,
): DriftCandidate[] {
	return candidates.filter((c) => {
		if (c.lastCheckedAt === null) return true;
		const cadence = DRIFT_CADENCE_MS[c.tier];
		return now.getTime() - c.lastCheckedAt.getTime() >= cadence;
	});
}
