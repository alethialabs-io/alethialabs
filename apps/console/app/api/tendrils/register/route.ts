// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { getServiceDb } from "@/lib/db";
import { runners } from "@/lib/db/schema";
import { verifyPlatformSecret } from "@/lib/platform/auth";
import { createHash, randomBytes } from "crypto";
import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";

/** Terraform calls this to register a cloud-hosted tendril. */
export async function POST(req: Request) {
	const unauthorized = verifyPlatformSecret(req);
	if (unauthorized) return unauthorized;

	let body: { name?: string; mode?: "self-hosted" | "cloud-hosted" };
	try {
		body = await req.json();
	} catch {
		return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
	}

	const { name, mode } = body;
	if (!name || typeof name !== "string") {
		return NextResponse.json(
			{ error: "Missing required field: name" },
			{ status: 400 },
		);
	}

	const tendrilToken = randomBytes(32).toString("hex");
	const tokenHash = createHash("sha256").update(tendrilToken).digest("hex");

	try {
		const db = getServiceDb();
		const [row] = await db
			.insert(runners)
			.values({ name, mode: mode ?? "cloud-hosted", token_hash: tokenHash })
			.onConflictDoUpdate({
				target: runners.name,
				targetWhere: sql`mode = 'cloud-hosted'`,
				set: { token_hash: tokenHash },
			})
			.returning({ id: runners.id });

		return NextResponse.json({
			tendril_id: row.id,
			tendril_token: tendrilToken,
		});
	} catch (err: unknown) {
		const message =
			err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json(
			{ error: "Failed to register tendril: " + message },
			{ status: 500 },
		);
	}
}
