// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/** Next.js server-startup hook. Runs once per app instance on the Node runtime. */
export async function register() {
	if (process.env.NEXT_RUNTIME !== "nodejs") return;
	const { startStaleJobRecovery } = await import("@/lib/jobs/recovery");
	startStaleJobRecovery();
	// In-app fleet controller (sibling loop). Pools live in the DB; import any legacy
	// FLEET_POOLS env config once, then run the loop (a no-op tick when no pools exist).
	const { seedFleetPoolsFromEnv } = await import("@/lib/fleet/pools-db");
	await seedFleetPoolsFromEnv().catch((err) =>
		console.error("[fleet] pool seed failed:", err),
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
	// Sync the static authz registry (permissions + built-in roles) — idempotent.
	const { seedAuthz } = await import("@/lib/authz/seed");
	await seedAuthz().catch((err) => console.error("[authz] seed failed:", err));
	// Mirror the model + grants into OpenFGA when the enterprise engine is active;
	// a no-op in the community build. Runs after the registry seed so grants exist.
	const { getTupleSync } = await import("@/lib/authz/tuple-sync");
	void getTupleSync()
		.backfill()
		.catch((err) => console.error("[authz] FGA backfill failed:", err));
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
	console.error(
		`[onRequestError] ${request.method ?? "?"} ${request.path ?? context.routePath ?? "?"} (${context.routeType ?? "?"}) digest=${e?.digest ?? "-"}\n${e?.stack ?? e?.message ?? String(error)}`,
	);
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
	}
}
