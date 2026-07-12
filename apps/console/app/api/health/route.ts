// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { isInternalAuthorized } from "@/lib/auth/internal-auth";
import { getDeepHealth, httpStatusFor } from "@/lib/observability/health";

// Uses node crypto (constant-time bearer check) + the postgres probe, so pin the Node runtime.
export const runtime = "nodejs";
// Always evaluated at request time (the deep result has its own short TTL cache inside getDeepHealth).
export const dynamic = "force-dynamic";

/**
 * Health probe for load balancers, uptime monitors, the status page, and the (later) ops dashboard.
 *
 * Two modes off one route:
 *  - `?shallow=1` (or `?probe=live`) — LIVENESS: process-up only, NO DB, NO loop registry read. Cheap
 *    200 for the LB liveness probe (restart-if-fails). Never touches Postgres, so a probe storm here is
 *    free. ALWAYS PUBLIC — a liveness probe must never carry a secret.
 *  - default — READINESS: the aggregate `status` (healthy | degraded | unhealthy) + the correct HTTP
 *    code (503 only when `unhealthy`; `degraded` stays 200 so a shared degradation can't cascade the LB
 *    into an outage — pass `?strict=1` to make `degraded` a 503 too). The aggregate is safe for any
 *    caller (an LB readiness probe needs the code, not a secret), but the DEEP DETAIL behind it — DB
 *    latency/errors, EACH supervised background loop's name + last-run/failure counters, the OTel
 *    collector endpoint — is internal topology and is DISCLOSED ONLY to a platform-internal caller
 *    presenting `Authorization: Bearer ${ALETHIA_CRON_SECRET}` (same scheme as the cron/maintenance
 *    routes). Anonymous readiness requests get the sanitized aggregate; the detail is fail-closed
 *    (never exposed when the secret is unset). The deep compute is cached (~5s), so hammering this
 *    never re-hits Postgres per request.
 *
 * Note: the ops dashboard + DR runbook read the FULL document server-side by importing
 * `getDeepHealth()` directly (not over this HTTP route), so gating the HTTP detail doesn't affect them.
 */
export async function GET(request: Request): Promise<Response> {
	const params = new URL(request.url).searchParams;

	// Liveness: cheap, DB-free, un-cached — just proves the process is up and serving. Always public.
	if (params.get("shallow") === "1" || params.get("probe") === "live") {
		return Response.json({
			status: "ok",
			mode: "live",
			ts: new Date().toISOString(),
		});
	}

	// Readiness: the deep, TTL-cached compute drives the aggregate + HTTP code for everyone …
	const health = await getDeepHealth();
	const status = httpStatusFor(health, params.get("strict") === "1");

	// … but the internal topology detail is only returned to a platform-internal (bearer) caller.
	if (isInternalAuthorized(request)) {
		return Response.json(health, { status });
	}

	// Anonymous / unauthenticated: sanitized aggregate only — same status code (so LB readiness probes
	// keep working), but NO db/loop/otel detail. Fail-closed: unset secret ⇒ nobody sees the detail.
	return Response.json(
		{ status: health.status, mode: "readiness", ts: health.ts },
		{ status },
	);
}
