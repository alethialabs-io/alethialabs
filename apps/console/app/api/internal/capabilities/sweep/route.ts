// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Internal refresh sweeper for the per-tenant capabilities catalog (epic #928 / #938) — re-runs each due
// connection's capability enumeration (the change-detector short-circuits the expensive work when nothing
// moved). Hit on a cadence by a platform cron (hosted) / interval (self-host), the same shape as the
// connections/alerts/drift sweepers. Guarded by the shared bearer secret (ALETHIA_CRON_SECRET); fails
// closed when unset.

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
