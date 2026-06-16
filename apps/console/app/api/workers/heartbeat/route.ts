// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { verifyWorkerToken } from "@/lib/workers/auth";
import { createServiceRoleClient } from "@/lib/supabase/service-role-client";
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
		const supabase = await createServiceRoleClient();

		const { error } = await supabase.rpc("worker_heartbeat", {
			p_worker_id: workerId,
			p_worker_token_hash: tokenHash,
			p_version: workerVersion,
		});

		if (error) {
			console.error("Heartbeat RPC error:", error);
			return NextResponse.json(
				{ error: "Failed to update heartbeat" },
				{ status: 500 },
			);
		}

		return NextResponse.json({ success: true });
	} catch (err: any) {
		console.error("Heartbeat error:", err);
		return NextResponse.json(
			{ error: "Internal Server Error" },
			{ status: 500 },
		);
	}
}
