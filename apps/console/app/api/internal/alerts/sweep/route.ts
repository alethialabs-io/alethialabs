// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Internal retry sweeper for alert deliveries (dataroom/spec/mvp/25-alerting-notifications.md).
// Hit on a minute cadence by a platform cron (the EventBridge→Lambda shape used by the
// fleet scaler). Guarded by a shared bearer secret (ALETHIA_CRON_SECRET); fails closed
// when unset so it can never be invoked anonymously.

import { NextResponse } from "next/server";
import { sweepDueDeliveries } from "@/lib/alerts/dispatch";

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
		const processed = await sweepDueDeliveries();
		return NextResponse.json({ processed });
	} catch (err) {
		const message = err instanceof Error ? err.message : "sweep failed";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
