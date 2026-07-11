// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Client-safe display helpers for the AI usage meters — the single source for how the
// rolling 5-hour session window and the fixed weekly limit are labeled ("Resets in
// 4 hr 48 min" / "Resets Tue 10:59 AM") and for the top-up upsell condition. Consolidates
// the previously per-component `resetsIn` helpers (usage section, overview card, chat
// error). No server imports — usable from any client component and from tests.

/** The slice of the AI usage summary the display helpers need (structural, so this
 *  module never imports the server-action type). */
export interface AiUsageWindows {
	sessionUsed: number;
	sessionBudget: number;
	weeklyUsed: number;
	weeklyBudget: number;
}

/**
 * Fraction of the session OR weekly budget at/above which the top-up upsell shows.
 * Top-up packs are paid-tier-only and only surface once a limit is actually near —
 * below this, the plan's included allowance is the whole story.
 */
export const AI_TOPUP_UPSELL_THRESHOLD = 0.8;

/** Humanize a positive ms delta ("4 hr 48 min", "48 min", "2 days 3 hr", "under a minute"). */
export function formatCountdown(ms: number): string {
	if (!Number.isFinite(ms) || ms < 60_000) return "under a minute";
	const totalMinutes = Math.floor(ms / 60_000);
	const days = Math.floor(totalMinutes / 1_440);
	const hours = Math.floor((totalMinutes % 1_440) / 60);
	const minutes = totalMinutes % 60;
	if (days >= 1)
		return hours > 0
			? `${days} day${days > 1 ? "s" : ""} ${hours} hr`
			: `${days} day${days > 1 ? "s" : ""}`;
	if (hours >= 1) return minutes > 0 ? `${hours} hr ${minutes} min` : `${hours} hr`;
	return `${minutes} min`;
}

/**
 * Sub-label for the session meter. `null` means no usage inside the trailing 5-hour
 * window — there is no active session yet, so there is nothing to count down.
 */
export function sessionResetLabel(
	iso: string | null,
	now: number = Date.now(),
): string {
	if (!iso) return "Starts on first use";
	const ms = new Date(iso).getTime() - now;
	if (Number.isNaN(ms)) return "Starts on first use";
	if (ms <= 0) return "Resets soon";
	return `Resets in ${formatCountdown(ms)}`;
}

/**
 * Sub-label for the weekly meter: the reset moment as a local weekday + time
 * ("Resets Tue 10:59 AM"). `locale` is only for deterministic tests — components
 * omit it so the viewer's own locale formats the time.
 */
export function weeklyResetLabel(
	iso: string,
	now: number = Date.now(),
	locale?: string,
): string {
	const at = new Date(iso);
	if (Number.isNaN(at.getTime())) return "—";
	if (at.getTime() - now <= 0) return "Resets soon";
	// Two formatters instead of one — a combined weekday+time format inserts a comma
	// ("Tue, 10:59 AM") that the meter label doesn't want.
	const weekday = new Intl.DateTimeFormat(locale, { weekday: "short" }).format(at);
	const time = new Intl.DateTimeFormat(locale, {
		hour: "numeric",
		minute: "2-digit",
	}).format(at);
	return `Resets ${weekday} ${time}`;
}

/** Percent of a budget used, rounded and clamped to 0–100 (0 when there is no budget). */
export function pctOf(used: number, budget: number): number {
	if (!(budget > 0)) return 0;
	return Math.min(100, Math.max(0, Math.round((used / budget) * 100)));
}

/** Whether session OR weekly usage is at/above the top-up upsell threshold. */
export function isNearAiLimit(windows: AiUsageWindows): boolean {
	const near = (used: number, budget: number) =>
		budget > 0 && used / budget >= AI_TOPUP_UPSELL_THRESHOLD;
	return (
		near(windows.sessionUsed, windows.sessionBudget) ||
		near(windows.weeklyUsed, windows.weeklyBudget)
	);
}
