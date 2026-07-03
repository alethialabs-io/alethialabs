// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { getServiceDb } from "@/lib/db";
import { cloudProvider } from "@/lib/db/schema";
import { verifyRunnerToken } from "@/lib/runners/auth";
import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

// Runners report the cloud providers their image can execute (per-cloud routing).
// Validated against the cloud_provider enum so only real providers reach the column.
// `.nullish()` because the full/"any provider" runner sends providers: null (its
// nil slice) to mean "no update" — distinct from a per-cloud image's ["aws"].
const providersSchema = z.array(z.enum(cloudProvider.enumValues)).nullish();

export async function POST(req: Request) {
	const { runnerId, tokenHash, error: authError } =
		await verifyRunnerToken(req);
	if (authError) return authError;

	let runnerVersion: string | null = null;
	let providers: string[] | null = null;
	try {
		const body = await req.json();
		runnerVersion = body.version ?? null;
		const parsed = providersSchema.safeParse(body.providers);
		if (!parsed.success) {
			return NextResponse.json(
				{ error: "Invalid providers (must be cloud_provider values)" },
				{ status: 400 },
			);
		}
		providers = parsed.data && parsed.data.length > 0 ? parsed.data : null;
	} catch {
		// Older runners send an empty body — that's fine (no version/providers update).
	}

	// Postgres array literal (values are enum-validated above); NULL keeps the
	// existing supported_providers (the full image reports none → stays "any").
	const providersLiteral = providers ? `{${providers.join(",")}}` : null;

	try {
		const db = getServiceDb();
		await db.execute(
			sql`select runner_heartbeat(${runnerId}::uuid, ${tokenHash}, ${runnerVersion}, ${providersLiteral}::cloud_provider[])`,
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
