// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { and, inArray } from "drizzle-orm";
import { NextResponse } from "next/server";
import { ForbiddenError } from "@/lib/authz";
import { authorizeCli } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";
import { jobs } from "@/lib/db/schema";
import { cancelJobAs } from "@/lib/jobs/cancel";
import { jobVisibleTo } from "@/lib/jobs/visibility";

/**
 * Cancels a job the CLI caller can see, through the same cancel the console uses
 * (lib/jobs/cancel.ts): the permission its operation takes on its target, a conditional flip from
 * QUEUED/CLAIMED/PROCESSING only, `completed_at`, and the runner signalled when the job it flipped
 * had been claimed.
 *
 * The read is the service connection, so the tenancy predicate is applied here by hand: THE SAME
 * ORG LIST `GET /api/jobs` USES, from the guard (`auth.orgScope`) rather than re-derived — a
 * narrower list let a Teams member list a pre-#3942 runner job and then 404 cancelling it (#4154).
 * Beside it, job visibility follows project visibility (lib/jobs/visibility.ts), as in the console.
 */
export async function POST(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id: jobId } = await params;

	const auth = await authorizeCli(req, "edit", { type: "job", id: jobId });
	if ("error" in auth) return auth.error;
	const { actor } = auth;

	try {
		const where = and(inArray(jobs.org_id, [...auth.orgScope]), await jobVisibleTo(actor));
		if (!where) throw new Error("no tenancy predicate");
		const outcome = await cancelJobAs(actor, jobId, where, (work) => getServiceDb().transaction(work));
		switch (outcome.kind) {
			case "cancelled":
				return NextResponse.json({ success: true });
			case "not-found":
				return NextResponse.json({ error: "Job not found or unauthorized" }, { status: 404 });
			case "no-target":
				return NextResponse.json(
					{ error: "This job's runner or project no longer exists, so it can't be cancelled here." },
					{ status: 409 },
				);
			case "not-cancellable":
				return NextResponse.json(
					{
						error: `Cannot cancel job with status ${outcome.status}. Only QUEUED, CLAIMED, or PROCESSING jobs can be cancelled.`,
					},
					{ status: 400 },
				);
		}
	} catch (err: unknown) {
		if (err instanceof ForbiddenError) {
			return NextResponse.json({ error: "Forbidden" }, { status: 403 });
		}
		const message = err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
