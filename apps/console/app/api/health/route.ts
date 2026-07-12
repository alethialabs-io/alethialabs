// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { getDeepHealth, httpStatusFor } from "@/lib/observability/health";

// Always evaluated at request time (the deep result has its own short TTL cache inside getDeepHealth).
export const dynamic = "force-dynamic";

/**
 * Health probe for load balancers, uptime monitors, the status page, and the (later) ops dashboard.
 *
 * Two modes off one route:
 *  - `?shallow=1` (or `?probe=live`) — LIVENESS: process-up only, NO DB, NO loop registry read. Cheap
 *    200 for the LB liveness probe (restart-if-fails). Never touches Postgres, so a probe storm here is
 *    free.
 *  - default — READINESS: the deep, TTL-cached document (DB reachability, each supervised background
 *    loop's liveness, OTel-collector reachability when configured) + an aggregate `status`
 *    (healthy | degraded | unhealthy). HTTP is 503 only when `unhealthy` (DB down); `degraded` (a stuck
 *    background loop) stays 200 so a shared degradation can't cascade the LB into an outage — pass
 *    `?strict=1` to make `degraded` a 503 too. The deep compute is cached (~5s), so hammering this never
 *    re-hits Postgres per request.
 */
export async function GET(request: Request): Promise<Response> {
	const params = new URL(request.url).searchParams;

	// Liveness: cheap, DB-free, un-cached — just proves the process is up and serving.
	if (params.get("shallow") === "1" || params.get("probe") === "live") {
		return Response.json({
			status: "ok",
			mode: "live",
			ts: new Date().toISOString(),
		});
	}

	// Readiness: the deep, TTL-cached document + aggregate status.
	const health = await getDeepHealth();
	return Response.json(health, {
		status: httpStatusFor(health, params.get("strict") === "1"),
	});
}
