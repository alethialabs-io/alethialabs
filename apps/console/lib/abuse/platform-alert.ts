// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The platform operator's alert for an abuse ceiling (REL-L11, #6912). Two things page the
// operator here, both through the EXISTING alert pipeline (`emitAlertEvent` on the operator org
// named by `ALETHIA_PLATFORM_ALERT_ORG_ID`, the same route `loop_degraded` and
// `payment_needs_support` take), never a channel of its own:
//
//   - a cost guard that FAILED OPEN — its count query errored and it admitted the request rather
//     than wedge a real user (the free job quota, the free AI pool). Before this, that path passed
//     silently (`job-quota.ts`, spec release-and-billing §4.5 "Runner minutes").
//   - the free AI pool reaching its global daily ceiling — every free organization's AI turns are
//     now paused until 00:00 UTC, which the operator needs to know the moment it happens.
//
// Both event keys are in `lib/alerts/catalog.ts` (the "Platform health" group), so the operator's
// rules can subscribe to them by name or by `system.platform.*`.
//
// THROTTLE. A failing count query fails on EVERY request until the database recovers, so each
// (event, subject) pair is latched in process memory for {@link PLATFORM_ALERT_LATCH_MS}: the first
// failure emits, the rest of the window only logs. The rule's own throttle collapses repeats across
// replicas. The log line is written every time, latched or not — during a database outage the emit
// itself may fail (the rule read is cached, the delivery insert is not), and the log is the backstop.

import "server-only";
import { emitAlertEvent } from "@/lib/alerts/emit";
import { log } from "@/lib/observability/log";

/** A cost guard's count query failed and it admitted the request anyway. */
export const COST_GUARD_FAILED_OPEN_EVENT = "system.platform.cost_guard_failed_open";

/** The free AI pool reached its global daily ceiling: free AI turns are paused until 00:00 UTC. */
export const FREE_AI_PAUSED_EVENT = "system.platform.free_ai_paused";

/** The event keys this module raises. */
export type PlatformAbuseEvent =
	| typeof COST_GUARD_FAILED_OPEN_EVENT
	| typeof FREE_AI_PAUSED_EVENT;

/** How long one (event, subject) pair stays latched after it emitted, per process. */
export const PLATFORM_ALERT_LATCH_MS = 15 * 60_000;

/** One platform alert: what fired, what it is about, and what a person reads. */
export interface PlatformAbuseAlert {
	event: PlatformAbuseEvent;
	/** The guard or pool this is about (`free_daily_jobs`, `free_ai_pool`); the throttle key. */
	subject: string;
	title: string;
	summary: string;
	severity: "warning" | "critical";
}

/** When each latched (event, subject) pair last emitted, in epoch ms. */
const latchedAt = new Map<string, number>();

/** Forgets every latch. Tests only: a fresh process has none. */
export function resetPlatformAlertLatches(): void {
	latchedAt.clear();
}

/**
 * Logs the alert and, unless the same (event, subject) emitted within the latch window, raises it
 * on the platform operator's org. Returns whether an emit was ATTEMPTED (false when latched or when
 * `ALETHIA_PLATFORM_ALERT_ORG_ID` is unset). Never throws and never awaits the delivery: it is
 * called from a request's hot path, and an alert failure must not fail or slow that request.
 */
export function raisePlatformAbuseAlert(
	alert: PlatformAbuseAlert,
	now: number = Date.now(),
): boolean {
	const fields = { event_key: alert.event, subject: alert.subject };
	if (alert.severity === "critical") log.error(`[abuse] ${alert.summary}`, fields);
	else log.warn(`[abuse] ${alert.summary}`, fields);

	const key = `${alert.event}:${alert.subject}`;
	const last = latchedAt.get(key);
	if (last !== undefined && now - last < PLATFORM_ALERT_LATCH_MS) return false;

	const orgId = process.env.ALETHIA_PLATFORM_ALERT_ORG_ID;
	if (!orgId) return false;
	latchedAt.set(key, now);

	void emitAlertEvent(orgId, alert.event, {
		title: alert.title,
		summary: alert.summary,
		severity: alert.severity,
		resource_type: "abuse_ceiling",
		resource_id: alert.subject,
	}).catch((err: unknown) => {
		log.error(`[alerts] emit failed (${alert.event})`, { event_key: alert.event, err });
	});
	return true;
}
