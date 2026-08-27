// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Internal drift scheduler (elench): enqueue DETECT_DRIFT jobs for environments whose last
// refresh-only check is older than their tier cadence (lib/drift/schedule + dispatch).
//
// WHY IT EXISTS THOUGH NOTHING CALLS IT: the same `sweepDriftSchedule()` is already driven IN-PROCESS
// by the supervised reconcile loop as its "drift-schedule" reconciler (lib/reconcile/loop.ts, booted
// from instrumentation.ts), so drift keeps being re-proved with no external trigger. This route is the
// optional externally-driven twin — for a hosted operator who prefers an external cron, or a manual
// one-shot. Same deal as the alerts/connections/capabilities sweepers; .env.example documents all four
// together under ALETHIA_CRON_SECRET as the manual maintenance endpoints.
//
// Verified 2026-08-27 (#2874) — do NOT re-derive this: nothing in infra/**, deploy/**, .github/** or
// apps/{cli,runner,admin} POSTs this path. NOTE that ELENCH.md and apps/docs elench/engine-internals
// still describe the platform cron as the trigger and call it "ops config"; that is stale — the
// in-process reconciler is the real driver. (Both files are outside this change's scope.)
//
// Guarded by the shared bearer secret (ALETHIA_CRON_SECRET); fails closed (503) when unset.

import { NextResponse } from "next/server";
import { isInternalAuthorized } from "@/lib/auth/internal-auth";
import { sweepDriftSchedule } from "@/lib/drift/dispatch";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<NextResponse> {
	const secret = process.env.ALETHIA_CRON_SECRET;
	if (!secret) {
		return NextResponse.json(
			{ error: "drift scheduler not configured (ALETHIA_CRON_SECRET unset)" },
			{ status: 503 },
		);
	}
	if (!isInternalAuthorized(req)) {
		return NextResponse.json({ error: "unauthorized" }, { status: 401 });
	}

	try {
		const { enqueued } = await sweepDriftSchedule();
		return NextResponse.json({ enqueued });
	} catch (err) {
		const message = err instanceof Error ? err.message : "drift sweep failed";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
