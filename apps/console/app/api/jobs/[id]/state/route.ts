// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Console tofu-state HTTP backend (E0). Serves a project environment's tofu state to the runner so
// a managed runner never holds the storage master credential (the retired s3 backend wrote it into
// backend.hcl in the tofu workdir). Authorized per-job + key-scoped by resolveStateRequest; the state
// key is always re-derived server-side from the job. Locking lives in the sibling /state/lock route.

import { NextResponse } from "next/server";
import { resolveStateRequest } from "@/lib/runners/state-auth";
import { validateStateLock } from "@/lib/runners/state-lock";
import { storage } from "@/lib/storage";
import { TOFU_STATE_BUCKET } from "@/lib/storage/tofu-state";

export const runtime = "nodejs";

/** tofu state can be several MB; cap it like the plan-artifact route. */
const MAX_STATE_BYTES = 50 * 1024 * 1024;

/** GET → the current state, or 404 when there is none yet (tofu treats 404 as empty state). */
export async function GET(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id } = await params;
	const ctx = await resolveStateRequest(req, id);
	if ("error" in ctx) return ctx.error;

	const data = await storage.get(TOFU_STATE_BUCKET, ctx.stateKey);
	if (!data) return new Response(null, { status: 404 });

	const out = new Uint8Array(data.byteLength);
	out.set(data);
	return new Response(out, {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

/** POST → write state. Fail-closed on the lock fence: tofu appends the held lock id as ?ID=. */
export async function POST(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id } = await params;
	const ctx = await resolveStateRequest(req, id);
	if ("error" in ctx) return ctx.error;

	// The ONLY lost-update guard (this backend has no ETag): reject a write whose lock id is not the
	// currently-held one — so a lock stolen after expiry can't clobber a slow writer.
	const lockId = new URL(req.url).searchParams.get("ID");
	if (!lockId || !(await validateStateLock(ctx.stateKey, lockId))) {
		return NextResponse.json(
			{ error: "State is not locked by this operation" },
			{ status: 409 },
		);
	}

	const body = await req.arrayBuffer();
	if (body.byteLength > MAX_STATE_BYTES) {
		return NextResponse.json({ error: "State too large" }, { status: 413 });
	}

	await storage.put(
		TOFU_STATE_BUCKET,
		ctx.stateKey,
		new Uint8Array(body),
		"application/json",
	);
	return NextResponse.json({ success: true });
}

/** DELETE → purge state (tofu destroy / workspace delete). */
export async function DELETE(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id } = await params;
	const ctx = await resolveStateRequest(req, id);
	if ("error" in ctx) return ctx.error;

	await storage.del(TOFU_STATE_BUCKET, ctx.stateKey);
	return NextResponse.json({ success: true });
}
