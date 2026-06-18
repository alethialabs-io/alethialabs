// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { verifyCliToken } from "@/lib/cli/auth";
import { getServiceDb } from "@/lib/db";
import { runners } from "@/lib/db/schema";
import { createHash, randomBytes } from "crypto";
import { NextResponse } from "next/server";

export async function POST(req: Request) {
	const { payload, error: authError } = await verifyCliToken(req);
	if (authError) return authError;

	const userId = payload?.sub;
	if (!userId) {
		return NextResponse.json(
			{ error: "Invalid token payload" },
			{ status: 401 },
		);
	}

	try {
		const { name, mode, cloud_identity_id, metadata } = await req.json();

		if (!name || !mode) {
			return NextResponse.json(
				{ error: "name and mode are required" },
				{ status: 400 },
			);
		}

		if (mode !== "self-hosted") {
			return NextResponse.json(
				{ error: "Only self-hosted workers can be registered by users" },
				{ status: 400 },
			);
		}

		const workerToken = randomBytes(32).toString("hex");
		const tokenHash = createHash("sha256").update(workerToken).digest("hex");

		const db = getServiceDb();
		const [worker] = await db
			.insert(runners)
			.values({
				user_id: userId,
				name,
				mode,
				cloud_identity_id: cloud_identity_id || null,
				token_hash: tokenHash,
				metadata: metadata || {},
			})
			.returning({
				id: runners.id,
				name: runners.name,
				mode: runners.mode,
				status: runners.status,
				// snake_case key preserves the Go CLI's Worker wire contract.
				created_at: runners.created_at,
			});

		return NextResponse.json(
			{ worker, worker_token: workerToken },
			{ status: 201 },
		);
	} catch (err: unknown) {
		const message =
			err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
