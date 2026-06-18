// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { verifyCliToken } from "@/lib/cli/auth";
import { getServiceDb } from "@/lib/db";
import { jobs } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";

/** Fetches a single job by ID, verifying CLI token ownership. */
export async function GET(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { payload, error: authError } = await verifyCliToken(req);
	if (authError) return authError;

	const userId = payload?.sub;
	if (!userId) {
		return NextResponse.json(
			{ error: "Invalid token payload" },
			{ status: 401 },
		);
	}

	const { id: jobId } = await params;

	try {
		const db = getServiceDb();
		const [job] = await db
			.select()
			.from(jobs)
			.where(and(eq(jobs.id, jobId), eq(jobs.user_id, userId)))
			.limit(1);

		if (!job) {
			return NextResponse.json({ error: "Job not found" }, { status: 404 });
		}

		return NextResponse.json(job);
	} catch (err: unknown) {
		const message =
			err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
