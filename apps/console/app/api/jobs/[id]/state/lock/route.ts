// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Lock/unlock endpoint for the console tofu-state HTTP backend (E0). tofu's http backend can't use the
// non-standard LOCK/UNLOCK verbs against App Router, so the runner's backend config maps them to
// lock_method=POST / unlock_method=DELETE against this address. On contention we return 423 + the
// current holder's lock-info JSON so tofu can report who holds the lock.

import { NextResponse } from "next/server";
import { asRecord } from "@/lib/records";
import { resolveStateRequest } from "@/lib/runners/state-auth";
import { acquireStateLock, releaseStateLock } from "@/lib/runners/state-lock";

export const runtime = "nodejs";

/** POST → acquire the lock (tofu LOCK). Body is tofu's lock-info JSON (carries the lock ID). */
export async function POST(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id } = await params;
	const ctx = await resolveStateRequest(req, id);
	if ("error" in ctx) return ctx.error;

	const info = asRecord(await req.json().catch(() => null));
	const lockId = typeof info.ID === "string" ? info.ID : null;
	if (!lockId) {
		return NextResponse.json({ error: "Invalid lock info" }, { status: 400 });
	}

	const { acquired, holder } = await acquireStateLock(
		ctx.stateKey,
		lockId,
		id,
		info,
	);
	if (acquired) return NextResponse.json(info, { status: 200 });
	// 423 Locked + the current holder's info — tofu parses this to show who holds the lock.
	return NextResponse.json(holder ?? {}, { status: 423 });
}

/** DELETE → release the lock (tofu UNLOCK / force-unlock). Body is the lock-info JSON. */
export async function DELETE(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id } = await params;
	const ctx = await resolveStateRequest(req, id);
	if ("error" in ctx) return ctx.error;

	const info = asRecord(await req.json().catch(() => null));
	const lockId = typeof info.ID === "string" ? info.ID : null;
	if (lockId) await releaseStateLock(ctx.stateKey, lockId);
	return NextResponse.json({ success: true });
}
