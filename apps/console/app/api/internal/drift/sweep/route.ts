// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Internal drift scheduler (elench): on a cron cadence, enqueue DETECT_DRIFT jobs
// for environments whose last refresh-only check is older than their tier cadence
// (lib/drift/schedule + dispatch). Guarded by the shared bearer secret
// (ALETHIA_CRON_SECRET); fails closed when unset, mirroring the alerts sweeper.

import { NextResponse } from "next/server";
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
	if (req.headers.get("authorization") !== `Bearer ${secret}`) {
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
