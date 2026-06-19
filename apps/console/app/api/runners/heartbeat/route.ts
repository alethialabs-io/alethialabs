// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { getServiceDb } from "@/lib/db";
import { verifyRunnerToken } from "@/lib/runners/auth";
import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";

export async function POST(req: Request) {
	const { runnerId, tokenHash, error: authError } =
		await verifyRunnerToken(req);
	if (authError) return authError;

	let runnerVersion: string | null = null;
	try {
		const body = await req.json();
		runnerVersion = body.version ?? null;
	} catch {
		// Older runners send empty body — that's fine
	}

	try {
		const db = getServiceDb();
		await db.execute(
			sql`select runner_heartbeat(${runnerId}::uuid, ${tokenHash}, ${runnerVersion})`,
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
