// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/** Next.js server-startup hook. Runs once per app instance on the Node runtime. */
export async function register() {
	if (process.env.NEXT_RUNTIME !== "nodejs") return;
	const { log } = await import("@/lib/observability/log");
	const startupLog = log.child({ component: "instrumentation" });
	// Boot the OTel traces + metrics SDK FIRST so the global tracer/meter are registered
	// before any loop or request records a span/metric. Endpoint-gated: unset ⇒ a complete
	// no-op (no provider registered), so this never adds cost or a dependency. It patches
	// nothing (no auto-instrumentations), so the sibling loops below are unaffected.
	const { startOtel } = await import("@/lib/observability/otel");
	startOtel();
	// Sentry error tracking (DSN-gated: a complete no-op unless SENTRY_DSN is set — @sentry/nextjs is
	// not even imported). Booted AFTER OTel and configured to NOT install its own tracer/propagator
	// (skipOpenTelemetrySetup) so the OTel SDK above + the sibling loops below are untouched. Never
	// throws — a bad DSN degrades to no error tracking, it can't crash startup.
	if (process.env.SENTRY_DSN) {
		const { initSentryServer } = await import("@/lib/observability/sentry");
		await initSentryServer().catch((err) =>
			startupLog.error("sentry init failed", { component: "sentry", err }),
		);
	}
	const { startStaleJobRecovery } = await import("@/lib/jobs/recovery");
	startStaleJobRecovery();
	// In-app fleet controller (sibling loop). Pools live in the DB; import any legacy
	// FLEET_POOLS env config once, then run the loop (a no-op tick when no pools exist).
	const { seedFleetPoolsFromEnv } = await import("@/lib/fleet/pools-db");
	await seedFleetPoolsFromEnv().catch((err) =>
		startupLog.error("pool seed failed", { component: "fleet", err }),
	);
	const { startFleetScaler } = await import("@/lib/fleet/scaler");
	startFleetScaler();
	// In-app alert-delivery retry sweep (self-hostable; no external cron).
	const { startAlertScheduler } = await import("@/lib/alerts/scheduler");
	startAlertScheduler();
	// In-app connection sweep: keeps cloud health + the asset-inventory baseline fresh and backfills
	// never-synced connections (self-hostable; no external cron — the /api route stays for hosted).
	const { startConnectionSweeper } = await import("@/lib/cloud-providers/sweep");
	startConnectionSweeper();
	// Supervised reconcile loop (B2c "keep proving it + self-heal + don't leak"): env-status
	// convergence backstop, periodic drift scheduler, ephemeral-env reaper, and retention GC —
	// each heartbeat-stamped. Sibling to the loops above; idempotent + safe across instances.
	const { startReconcileLoop } = await import("@/lib/reconcile/loop");
	startReconcileLoop();
	// Independent loop-liveness watcher — raises the throttled degraded alerts on its OWN interval, not
	// hosted in any supervised loop, so a dead loop (incl. reconcile) can't mute alerting for all loops.
	const { startHeartbeatWatcher } = await import(
		"@/lib/observability/heartbeats"
	);
	startHeartbeatWatcher();
	// Sync the static authz registry (permissions + built-in roles) — idempotent.
	const { seedAuthz } = await import("@/lib/authz/seed");
	await seedAuthz().catch((err) =>
		startupLog.error("seed failed", { component: "authz", err }),
	);
	// Mirror the model + grants into OpenFGA when the enterprise engine is active;
	// a no-op in the community build. Runs after the registry seed so grants exist.
	const { getTupleSync } = await import("@/lib/authz/tuple-sync");
	void getTupleSync()
		.backfill()
		.catch((err) =>
			startupLog.error("FGA backfill failed", { component: "authz", err }),
		);
}

/**
 * Captures the FULL server stack for any uncaught request error (Server Components, Route
 * Handlers, Server Actions). The dev overlay and terminal otherwise collapse app frames as
 * "ignore-listed", which hides the real throw site; this logs the unredacted stack + digest
 * so a digest seen in the browser maps to an exact `file:line` here.
 */
export async function onRequestError(
	error: unknown,
	request: { path?: string; method?: string },
	context: { routePath?: string; routeType?: string },
): Promise<void> {
	const e = error as { message?: string; stack?: string; digest?: string };
	const { log } = await import("@/lib/observability/log");
	log.child({ component: "onRequestError" }).error("uncaught request error", {
		method: request.method ?? "?",
		path: request.path ?? context.routePath ?? "?",
		route_type: context.routeType ?? "?",
		digest: e?.digest ?? "-",
		stack: e?.stack ?? e?.message ?? String(error),
	});
	// Also forward to PostHog Error Tracking so server-side throws (Route Handlers, Server Actions,
	// Server Components) are visible in prod — not just stdout. Node-only (posthog-node); best-effort:
	// captureServerException no-ops without the PostHog key and never throws. Fire-and-forget so it
	// never blocks or masks the original error path.
	if (process.env.NEXT_RUNTIME === "nodejs") {
		const { captureServerException } = await import("@/lib/analytics/server");
		void captureServerException(error, {
			props: {
				path: request.path ?? context.routePath ?? "unknown",
				method: request.method ?? "unknown",
				routeType: context.routeType ?? "unknown",
				digest: e?.digest ?? "",
			},
		});
		// Also forward to Sentry (→ self-hosted GlitchTip) when SENTRY_DSN is set. DSN-gated no-op
		// otherwise; fire-and-forget + best-effort so it never blocks or masks the original error.
		if (process.env.SENTRY_DSN) {
			const { captureServerError } = await import("@/lib/observability/sentry");
			void captureServerError(error, {
				path: request.path,
				method: request.method,
				routeType: context.routeType,
				routePath: context.routePath,
				digest: e?.digest,
			});
		}
	}
}
