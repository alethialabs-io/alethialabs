// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Platform-internal: one decision from the staff privacy queue (apps/admin) — verify, extend, hold,
// refuse or fulfil a case, or open one from an email. Guarded by the dedicated
// PLATFORM_PROVISION_SECRET, compared in constant time, and fails closed when unset. The work is
// `runStaffPrivacyAction` (lib/privacy/staff-queue.ts), which runs the same steps a console
// decision does and records each in the case's ledger under the staff member's user id.

import { NextResponse } from "next/server";
import { isPlatformProvisionAuthorized } from "@/lib/auth/internal-auth";
import { log } from "@/lib/observability/log";
import { runStaffPrivacyAction, staffPrivacyActionSchema } from "@/lib/privacy/staff-queue";

/** Carries out one staff privacy decision for an authorized internal caller. */
export async function POST(req: Request): Promise<NextResponse> {
	if (!process.env.PLATFORM_PROVISION_SECRET) {
		return NextResponse.json(
			{ error: "platform provisioning not configured (PLATFORM_PROVISION_SECRET unset)" },
			{ status: 503 },
		);
	}
	if (!isPlatformProvisionAuthorized(req)) {
		return NextResponse.json({ error: "unauthorized" }, { status: 401 });
	}
	const parsed = staffPrivacyActionSchema.safeParse(await req.json().catch(() => null));
	if (!parsed.success) {
		return NextResponse.json({ error: "invalid request body" }, { status: 400 });
	}
	try {
		const result = await runStaffPrivacyAction(parsed.data, new Date());
		// 200 either way: a step the case refuses (no reason, not verified) is an answer for the operator.
		return NextResponse.json(result);
	} catch (err) {
		log.error("[privacy] staff privacy action failed", { err, action: parsed.data.action });
		return NextResponse.json({ error: "the privacy action failed" }, { status: 500 });
	}
}
