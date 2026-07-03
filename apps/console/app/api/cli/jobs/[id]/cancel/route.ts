// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { authorizeCli } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";
import { jobs } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";

/** Cancels a job owned by the CLI user. Only QUEUED/CLAIMED/PROCESSING jobs can be cancelled. */
export async function POST(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id: jobId } = await params;

	const auth = await authorizeCli(req, "edit", { type: "job", id: jobId });
	if ("error" in auth) return auth.error;
	const { actor } = auth;

	try {
		const db = getServiceDb();

		const [job] = await db
			.select({ status: jobs.status })
			.from(jobs)
			.where(and(eq(jobs.id, jobId), eq(jobs.org_id, actor.orgId)))
			.limit(1);

		if (!job) {
			return NextResponse.json(
				{ error: "Job not found or unauthorized" },
				{ status: 404 },
			);
		}

		const cancellable = ["QUEUED", "CLAIMED", "PROCESSING"];
		if (!cancellable.includes(job.status)) {
			return NextResponse.json(
				{
					error: `Cannot cancel job with status ${job.status}. Only QUEUED, CLAIMED, or PROCESSING jobs can be cancelled.`,
				},
				{ status: 400 },
			);
		}

		await db
			.update(jobs)
			.set({ status: "CANCELLED" })
			.where(eq(jobs.id, jobId));

		return NextResponse.json({ success: true });
	} catch (err: unknown) {
		const message =
			err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
