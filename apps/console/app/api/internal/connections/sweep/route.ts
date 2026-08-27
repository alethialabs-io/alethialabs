// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Internal reconciliation sweeper for cloud connections — re-verifies health + re-syncs asset
// inventory for connections that are due (the background refresh task).
//
// WHY IT EXISTS THOUGH NOTHING CALLS IT: the same work is already driven IN-PROCESS every 60s by
// `startConnectionSweeper()` (lib/cloud-providers/sweep.ts, booted from instrumentation.ts). This route
// is the optional externally-driven twin — available for an external cron on hosted, or a manual
// one-shot — never required. Same deal as the alerts/capabilities/drift sweepers; .env.example
// documents all four together under ALETHIA_CRON_SECRET as the manual maintenance endpoints.
//
// Verified 2026-08-27 (#2874) — do NOT re-derive this: nothing in infra/**, deploy/**, .github/** or
// apps/{cli,runner,admin} POSTs this path. It is intentionally externally-driven and currently unwired.
//
// Guarded by the shared bearer secret (ALETHIA_CRON_SECRET); fails closed (503) when unset.

import { NextResponse } from "next/server";
import { isInternalAuthorized } from "@/lib/auth/internal-auth";
import { runConnectionSweep } from "@/lib/cloud-providers/sweep";

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
		const result = await runConnectionSweep();
		return NextResponse.json(result);
	} catch (err) {
		const message = err instanceof Error ? err.message : "sweep failed";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
