// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Internal reconciliation sweeper for cloud connections — re-verifies health + re-syncs asset
// inventory for connections that are due (the background refresh task). Hit on a cadence by a platform
// cron (hosted) / interval (self-host), the same shape as the alerts/drift sweepers. Guarded by the
// shared bearer secret (ALETHIA_CRON_SECRET); fails closed when unset.

import { NextResponse } from "next/server";
import { runConnectionSweep } from "@/lib/cloud-providers/sweep";

export async function POST(req: Request): Promise<NextResponse> {
	const secret = process.env.ALETHIA_CRON_SECRET;
	if (!secret) {
		return NextResponse.json(
			{ error: "cron sweeper not configured (ALETHIA_CRON_SECRET unset)" },
			{ status: 503 },
		);
	}
	if (req.headers.get("authorization") !== `Bearer ${secret}`) {
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
