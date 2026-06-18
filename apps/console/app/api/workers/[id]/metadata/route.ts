// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { getServiceDb } from "@/lib/db";
import { runners } from "@/lib/db/schema";
import { verifyWorkerToken } from "@/lib/workers/auth";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

/** Updates the metadata JSONB for a worker. Called by the runner after successful deploy. */
export async function PATCH(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { error: authError } = await verifyWorkerToken(req);
	if (authError) return authError;

	const { id: workerId } = await params;

	try {
		const metadata = await req.json();

		const db = getServiceDb();
		await db.update(runners).set({ metadata }).where(eq(runners.id, workerId));

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
