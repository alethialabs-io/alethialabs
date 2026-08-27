// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Internal retry sweeper for alert deliveries (dataroom/spec/mvp/25-alerting-notifications.md) —
// one call runs one `sweepDueDeliveries()` pass.
//
// WHY IT EXISTS THOUGH NOTHING CALLS IT: the same work is already driven IN-PROCESS every 60s by
// `startAlertScheduler()` (lib/alerts/scheduler.ts, booted from instrumentation.ts), so this route is
// never REQUIRED for a delivery to retry. It is the optional externally-driven twin, kept for a hosted
// operator who prefers an external cron over the in-app loop, and for a manual one-shot flush. Same
// deal as the connections/capabilities/drift sweepers; .env.example documents all four together under
// ALETHIA_CRON_SECRET as the manual maintenance endpoints.
//
// Verified 2026-08-27 (#2874) — do NOT re-derive this: no EventBridge rule, CronJob, workflow or
// Terraform anywhere in the monorepo POSTs this path (checked infra/**, deploy/**, .github/**, and
// apps/{cli,runner,admin}). An earlier version of this comment claimed a platform cron hit it "on a
// minute cadence ... the EventBridge→Lambda shape used by the fleet scaler"; that was never true —
// the only EventBridge→Lambda shape in the repo POSTs /api/cloud-events/<provider>, and the fleet
// scaler is itself an in-process loop. If you ever wire a real cron, say so here.
//
// Guarded by the shared bearer secret (ALETHIA_CRON_SECRET); fails closed (503) when unset, so it can
// never be invoked anonymously.

import { NextResponse } from "next/server";
import { isInternalAuthorized } from "@/lib/auth/internal-auth";
import { sweepDueDeliveries } from "@/lib/alerts/dispatch";

export async function POST(req: Request): Promise<NextResponse> {
	const secret = process.env.ALETHIA_CRON_SECRET;
	if (!secret) {
		return NextResponse.json(
			{ error: "cron sweeper not configured (ALETHIA_CRON_SECRET unset)" },
			{ status: 503 },
		);
	}
	if (!isInternalAuthorized(req)) {
		return NextResponse.json({ error: "unauthorized" }, { status: 401 });
	}

	try {
		const processed = await sweepDueDeliveries();
		return NextResponse.json({ processed });
	} catch (err) {
		const message = err instanceof Error ? err.message : "sweep failed";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
