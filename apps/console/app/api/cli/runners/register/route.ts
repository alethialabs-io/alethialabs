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
		const { name, cloud_identity_id, metadata } = await req.json();

		if (!name) {
			return NextResponse.json(
				{ error: "name is required" },
				{ status: 400 },
			);
		}

		// User-registered runners are always self-operated and brought by the
		// user (no DEPLOY_RUNNER job), i.e. provisioning=registered.
		const runnerToken = randomBytes(32).toString("hex");
		const tokenHash = createHash("sha256").update(runnerToken).digest("hex");

		const db = getServiceDb();
		const [runner] = await db
			.insert(runners)
			.values({
				user_id: userId,
				name,
				operator: "self",
				provisioning: "registered",
				cloud_identity_id: cloud_identity_id || null,
				token_hash: tokenHash,
				metadata: metadata || {},
			})
			.returning({
				id: runners.id,
				name: runners.name,
				operator: runners.operator,
				provisioning: runners.provisioning,
				status: runners.status,
				// snake_case key preserves the Go CLI's Runner wire contract.
				created_at: runners.created_at,
			});

		return NextResponse.json(
			{ runner, runner_token: runnerToken },
			{ status: 201 },
		);
	} catch (err: unknown) {
		const message =
			err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
