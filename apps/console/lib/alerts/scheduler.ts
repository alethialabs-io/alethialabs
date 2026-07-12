// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// In-app alert-delivery retry sweep — the same self-hostable pattern as the stale-job
// recovery loop (lib/jobs/recovery.ts), NOT an external cron / EventBridge. Each app
// instance runs the interval; deliverOne claims rows atomically so concurrent instances
// never double-send. Inline dispatch (emit.ts) handles first-attempt latency; this just
// retries the ones that failed or were left pending. See dataroom/spec/mvp/25-alerting-notifications.md.

import { sweepDueDeliveries } from "@/lib/alerts/dispatch";
import {
	registerLoop,
	superviseLoop,
} from "@/lib/observability/heartbeats";

const SWEEP_INTERVAL_MS = 60_000;

/** Stable supervision id for this loop (lib/observability/heartbeats.ts). */
export const ALERT_SCHEDULER_LOOP_ID = "alert-scheduler";

const globalForAlertSweep = globalThis as unknown as {
	__alethiaAlertSweep?: ReturnType<typeof setInterval>;
};

/** Starts the periodic delivery sweep (idempotent across HMR/instances). Heartbeat-supervised
 *  (lib/observability/heartbeats.ts) so /health can see it ticking. */
export function startAlertScheduler(): void {
	if (globalForAlertSweep.__alethiaAlertSweep) return;
	if (!process.env.ALETHIA_DATABASE_URL) return; // no DB configured yet

	registerLoop(ALERT_SCHEDULER_LOOP_ID, { intervalMs: SWEEP_INTERVAL_MS });
	globalForAlertSweep.__alethiaAlertSweep = setInterval(() => {
		void superviseLoop(ALERT_SCHEDULER_LOOP_ID, sweepDueDeliveries);
	}, SWEEP_INTERVAL_MS);
}
