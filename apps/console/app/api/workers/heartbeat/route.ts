// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { getServiceDb } from "@/lib/db";
import { verifyWorkerToken } from "@/lib/workers/auth";
import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";

export async function POST(req: Request) {
	const { workerId, tokenHash, error: authError } =
		await verifyWorkerToken(req);
	if (authError) return authError;

	let workerVersion: string | null = null;
	try {
		const body = await req.json();
		workerVersion = body.version ?? null;
	} catch {
		// Older workers send empty body — that's fine
	}

	try {
		const db = getServiceDb();
		await db.execute(
			sql`select runner_heartbeat(${workerId}::uuid, ${tokenHash}, ${workerVersion})`,
		);
		return NextResponse.json({ success: true });
	} catch (err) {
		console.error("Heartbeat error:", err);
		return NextResponse.json(
			{ error: "Failed to update heartbeat" },
			{ status: 500 },
		);
	}
}
