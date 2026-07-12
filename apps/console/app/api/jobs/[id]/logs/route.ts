// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { getServiceDb } from "@/lib/db";
import { jobLogs } from "@/lib/db/schema";
import { verifyRunnerOwnsJob, verifyRunnerToken } from "@/lib/runners/auth";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import { NextResponse } from "next/server";

export async function POST(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { runnerId, tokenHash, error: authError } =
		await verifyRunnerToken(req);
	if (authError) return authError;

	const { id: jobId } = await params;

	try {
		const { log_chunk, stream_type, traceparent } = await req.json();

		if (!log_chunk) {
			return NextResponse.json(
				{ error: "log_chunk is required" },
				{ status: 400 },
			);
		}

		const db = getServiceDb();
		await db.execute(
			sql`select insert_job_log(${runnerId}::uuid, ${tokenHash}, ${jobId}::uuid, ${log_chunk}, ${stream_type || "STDOUT"}, ${traceparent || null})`,
		);

		return NextResponse.json({ success: true }, { status: 201 });
	} catch (err) {
		const message = err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}

export async function GET(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { runnerId, error: authError } = await verifyRunnerToken(req);
	if (authError) return authError;

	const { id: jobId } = await params;

	const ownershipError = await verifyRunnerOwnsJob(runnerId, jobId);
	if (ownershipError) return ownershipError;

	const { searchParams } = new URL(req.url);
	const after = searchParams.get("after");

	try {
		const db = getServiceDb();
		const logs = await db
			.select()
			.from(jobLogs)
			.where(
				after
					? and(eq(jobLogs.job_id, jobId), gt(jobLogs.id, parseInt(after, 10)))
					: eq(jobLogs.job_id, jobId),
			)
			.orderBy(asc(jobLogs.id));

		return NextResponse.json({ logs });
	} catch (err) {
		const message = err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
