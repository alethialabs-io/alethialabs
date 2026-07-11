// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { getServiceDb } from "@/lib/db";
import { runners } from "@/lib/db/schema";
import { verifyRunnerToken } from "@/lib/runners/auth";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

/** Deletes a runner record. Called by the runner after successful terraform destroy. */
export async function DELETE(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { runnerId: authRunnerId, error: authError } =
		await verifyRunnerToken(req);
	if (authError) return authError;

	const { id: runnerId } = await params;

	// A runner may only delete itself — the path id must be the caller.
	if (runnerId !== authRunnerId) {
		return NextResponse.json(
			{ error: "Runner may only modify itself" },
			{ status: 403 },
		);
	}

	try {
		const db = getServiceDb();
		await db.delete(runners).where(eq(runners.id, runnerId));
		return NextResponse.json({ success: true });
	} catch (err: unknown) {
		const message =
			err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json(
			{ error: "Failed to delete runner: " + message },
			{ status: 500 },
		);
	}
}
