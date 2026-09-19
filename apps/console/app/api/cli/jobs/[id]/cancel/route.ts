// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { authorizeCli } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";
import { jobs } from "@/lib/db/schema";
import { and, eq, inArray } from "drizzle-orm";
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
			// THE SAME ORG LIST `GET /api/jobs` USES, from the guard rather than re-derived here.
			// It was `eq(jobs.org_id, actor.orgId)`, one element narrower than the list — so a
			// session member of a Teams org could LIST a pre-#3942 runner job (whose `org_id` is
			// their own personal org) and then 404 trying to cancel the id it had just been
			// shown. `alethia jobs cancel --latest` reaches exactly that.
			//
			// It is `auth.orgScope` and not a ternary on `auth.credential`: the values are the
			// whole of #4154, and a per-route derivation is how the wide arm gets copied into a
			// fourth file.
			.where(and(eq(jobs.id, jobId), inArray(jobs.org_id, [...auth.orgScope])))
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
