// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Internal refresh sweeper for the per-tenant capabilities catalog (epic #928 / #938) — re-runs each due
// connection's capability enumeration (the change-detector short-circuits the expensive work when nothing
// moved).
//
// WHY IT EXISTS THOUGH NOTHING CALLS IT: the same work is already driven IN-PROCESS every 60s by
// `startCapabilitySweeper()` (lib/cloud-providers/capabilities/sweep.ts, booted from instrumentation.ts).
// This route is the optional externally-driven twin — available for an external cron on hosted, or a
// manual one-shot — never required. Same deal as the alerts/connections/drift sweepers; .env.example
// documents all four together under ALETHIA_CRON_SECRET as the manual maintenance endpoints.
//
// Verified 2026-08-27 (#2874) — do NOT re-derive this: nothing in infra/**, deploy/**, .github/** or
// apps/{cli,runner,admin} POSTs this path. It is intentionally externally-driven and currently unwired.
//
// Guarded by the shared bearer secret (ALETHIA_CRON_SECRET); fails closed (503) when unset.

import { NextResponse } from "next/server";
import { isInternalAuthorized } from "@/lib/auth/internal-auth";
import { runCapabilitySweep } from "@/lib/cloud-providers/capabilities/sweep";

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
		const result = await runCapabilitySweep();
		return NextResponse.json(result);
	} catch (err) {
		const message = err instanceof Error ? err.message : "sweep failed";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
