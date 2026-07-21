// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { getServiceDb } from "@/lib/db";
import { runners } from "@/lib/db/schema";
import { verifyRunnerToken } from "@/lib/runners/auth";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

/** Updates the metadata JSONB for a runner. Called by the runner after successful deploy. */
export async function PATCH(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { runnerId: authRunnerId, error: authError } =
		await verifyRunnerToken(req);
	if (authError) return authError;

	const { id: runnerId } = await params;

	// A runner may only update its own metadata — the path id must be the caller.
	if (runnerId !== authRunnerId) {
		return NextResponse.json(
			{ error: "Runner may only modify itself" },
			{ status: 403 },
		);
	}

	try {
		const metadata = await req.json();
		// Backstop: a live bearer token must never land in the plaintext metadata JSONB (#945). New
		// runners no longer send it; this catches an older runner binary mid-rollout still PATCHing it.
		if (
			metadata?.deploy_config &&
			typeof metadata.deploy_config === "object"
		) {
			delete metadata.deploy_config.runner_token;
		}

		const db = getServiceDb();
		await db.update(runners).set({ metadata }).where(eq(runners.id, runnerId));

		return NextResponse.json({ success: true });
	} catch (err: unknown) {
		const message =
			err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json(
			{ error: "Failed to update metadata: " + message },
			{ status: 500 },
		);
	}
}
