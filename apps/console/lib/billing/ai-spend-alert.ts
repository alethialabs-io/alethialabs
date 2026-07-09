// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";
import { aiTierSpec, resolveAiPlan } from "@/lib/billing/ai-plan";
import { sumCredits } from "@/lib/billing/ai-quota";
import { emitAlertEventSafe } from "@/lib/alerts/emit";

// AI spend-threshold alerting — the smallest useful version of deliverable 3's spend alerts.
// Called fire-and-forget from the metering chokepoint (recordAiUsage) after an included AI
// charge, it re-derives the org's weekly allowance, sums this week's included spend, and — if
// the org has crossed a configured % threshold — enqueues a `system.cost.budget_threshold`
// alert through the existing Alerts infra (lib/alerts/emit → the org's rules → bound
// channels). No new tables, no new emit key: it lights up the catalog's existing (previously
// inert) Cost → "Budget threshold crossed" event. Per-threshold/per-week dedupe (via the
// synthetic `resource_id` subject) means an org is alerted at most once per bucket per level,
// on top of each rule's own throttle.

const WEEK_MS = 7 * 24 * 3_600_000;

/** Epoch-aligned week bucket start — matches the guard's weekly window. */
function weekBucketStart(now: number): Date {
	return new Date(Math.floor(now / WEEK_MS) * WEEK_MS);
}

/**
 * Configured spend-alert thresholds as fractions of the weekly included allowance. Override
 * with `AI_SPEND_ALERT_THRESHOLDS` (comma-separated percents, e.g. "80,100"); defaults to
 * 80% (warning) + 100% (critical). Invalid/empty → the defaults.
 */
function spendThresholds(): number[] {
	const raw = process.env.AI_SPEND_ALERT_THRESHOLDS;
	if (raw) {
		const parsed = raw
			.split(",")
			.map((p) => Number(p.trim()) / 100)
			.filter((n) => Number.isFinite(n) && n > 0 && n <= 5);
		if (parsed.length > 0) return parsed.sort((a, b) => a - b);
	}
	return [0.8, 1.0];
}

/**
 * Check an org's weekly AI included-spend against the configured thresholds and, when the
 * highest crossed threshold changes bucket, emit a `system.cost.budget_threshold` alert.
 * Best-effort and idempotent per (org, week, threshold) — safe to call on every metered
 * action. No-op when the tier has no weekly cap. Never throws into the caller.
 */
export async function checkAiSpendThreshold(orgId: string): Promise<void> {
	const { tier } = await resolveAiPlan(orgId);
	const spec = aiTierSpec(tier);
	if (spec.weeklyCredits <= 0) return;

	const now = Date.now();
	const weekStart = weekBucketStart(now);
	const used = await sumCredits(orgId, "included", weekStart);
	const pct = used / spec.weeklyCredits;

	// The highest threshold this spend has crossed (thresholds are ascending).
	const thresholds = spendThresholds();
	let crossed: number | null = null;
	for (const t of thresholds) if (pct >= t) crossed = t;
	if (crossed === null) return;

	const day = weekStart.toISOString().slice(0, 10);
	emitAlertEventSafe(orgId, "system.cost.budget_threshold", {
		title: `AI spend at ${Math.round(pct * 100)}% of the weekly allowance`,
		summary: `${used} of ${spec.weeklyCredits} included AI credits used this week (${tier}).`,
		severity: crossed >= 1 ? "critical" : "warning",
		// Synthetic subject → the delivery dedupe fires this at most once per week per
		// threshold level (independent of each rule's own throttle window).
		resource_id: `ai-weekly-spend:${day}:${crossed}`,
		link: "/~/usage",
	});
}
