// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The payment-hold sweeper's optional externally-driven twin (ADR 0002 §5.4; S6 #5783). The same tick
// already runs in-process every 5 minutes (`startPaymentHoldSweeper`, booted from instrumentation.ts);
// this route is for an external cron on hosted, or a manual one-shot — never required. Running it beside
// the in-process loop is safe: each hold is advanced under its payer's lease, and each email under its
// notice claim.
//
// Guarded by the shared bearer secret (ALETHIA_CRON_SECRET), compared in constant time
// (`isInternalAuthorized`); fails closed (503) when unset. The response is counts only — no
// subscription, payer or amount leaves it.

import { NextResponse } from "next/server";
import { isInternalAuthorized } from "@/lib/auth/internal-auth";
import { runPaymentHoldSweep } from "@/lib/billing/payment-holds/sweeper";

/** Runs one payment-hold sweeper tick for an authorized internal caller. */
export async function POST(req: Request): Promise<NextResponse> {
	if (!process.env.ALETHIA_CRON_SECRET) {
		return NextResponse.json(
			{ error: "cron sweeper not configured (ALETHIA_CRON_SECRET unset)" },
			{ status: 503 },
		);
	}
	if (!isInternalAuthorized(req)) {
		return NextResponse.json({ error: "unauthorized" }, { status: 401 });
	}

	try {
		return NextResponse.json(await runPaymentHoldSweep());
	} catch (err) {
		console.error("[billing] payment-hold sweep (internal route) failed:", err);
		return NextResponse.json({ error: "sweep failed" }, { status: 500 });
	}
}
