// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { getServiceDb } from "@/lib/db";
import { runners } from "@/lib/db/schema";
import { createHash } from "crypto";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

export type RunnerAuthResult = {
	runnerId: string;
	tokenHash: string;
	error: NextResponse | null;
};

export async function verifyRunnerToken(
	req: Request,
): Promise<RunnerAuthResult> {
	const runnerId = req.headers.get("X-Runner-ID");
	const runnerToken = req.headers.get("X-Runner-Token");

	if (!runnerId || !runnerToken) {
		return {
			runnerId: "",
			tokenHash: "",
			error: NextResponse.json(
				{ error: "Missing X-Runner-ID or X-Runner-Token" },
				{ status: 401 },
			),
		};
	}

	const tokenHash = createHash("sha256").update(runnerToken).digest("hex");

	const db = getServiceDb();
	const [runner] = await db
		.select({ id: runners.id, token_hash: runners.token_hash })
		.from(runners)
		.where(eq(runners.id, runnerId))
		.limit(1);

	if (!runner || runner.token_hash !== tokenHash) {
		return {
			runnerId: "",
			tokenHash: "",
			error: NextResponse.json(
				{ error: "Invalid runner ID or token" },
				{ status: 401 },
			),
		};
	}

	return { runnerId, tokenHash, error: null };
}
