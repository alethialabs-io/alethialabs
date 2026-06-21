// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Managed-runner usage metering (ADR 17/20 §5). The billable unit is **job-minutes**
// (execution time of jobs that ran on a managed runner). Included allowance per plan
// lives in lib/billing/plan.ts (quotas.includedRunnerMinutes) — the source of truth;
// the Stripe graduated meter price (lib/billing/config.ts) must mirror it. Self-hosted
// runners are never metered; we never bill the customer's own cloud compute.

/** Overage price beyond the included allowance, in USD per job-minute. */
export const OVERAGE_RATE_PER_MIN = 0.012;

/** Threshold (fraction of included) at which we surface a friendly heads-up. */
export const USAGE_ALERT_THRESHOLD = 0.8;

export interface UsageSummary {
	usedMinutes: number;
	includedMinutes: number;
	/** Minutes beyond the included allowance (0 when within plan). */
	overageMinutes: number;
	/** Estimated overage cost in USD for `overageMinutes` at the overage rate. */
	overageCost: number;
	/** Fraction of the included allowance consumed (0..; can exceed 1). */
	pct: number;
	/** True once usage crosses the alert threshold. */
	approaching: boolean;
	/** True once usage exceeds the included allowance. */
	overLimit: boolean;
}

/**
 * Pure usage math: included vs used → overage minutes, cost, and progress. No I/O.
 * `includedMinutes` of 0 means everything is overage (pct = Infinity when used > 0).
 */
export function computeUsage(
	usedMinutes: number,
	includedMinutes: number,
	ratePerMin: number = OVERAGE_RATE_PER_MIN,
): UsageSummary {
	const used = Math.max(0, usedMinutes);
	const included = Math.max(0, includedMinutes);
	const overageMinutes = Math.max(0, used - included);
	// Round to cents to avoid float noise in the surfaced estimate.
	const overageCost = Math.round(overageMinutes * ratePerMin * 100) / 100;
	const pct = included > 0 ? used / included : used > 0 ? Number.POSITIVE_INFINITY : 0;
	return {
		usedMinutes: used,
		includedMinutes: included,
		overageMinutes,
		overageCost,
		pct,
		approaching: pct >= USAGE_ALERT_THRESHOLD,
		overLimit: overageMinutes > 0,
	};
}
