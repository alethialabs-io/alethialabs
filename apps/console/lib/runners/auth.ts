// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { getServiceDb } from "@/lib/db";
import { runners } from "@/lib/db/schema";
import { createHash, randomBytes } from "crypto";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

export type RunnerAuthResult = {
	runnerId: string;
	tokenHash: string;
	error: NextResponse | null;
};

/** SHA-256 hex digest of a runner token — what we store + compare (never the plaintext). */
export function hashRunnerToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

/** Mints a fresh runner bearer token + its stored hash. */
export function generateRunnerToken(): { token: string; hash: string } {
	const token = randomBytes(32).toString("hex");
	return { token, hash: hashRunnerToken(token) };
}

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

	const tokenHash = hashRunnerToken(runnerToken);

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
