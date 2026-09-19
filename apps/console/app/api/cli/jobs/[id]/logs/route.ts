// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { authorizeCli } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";
import { jobLogs, jobs } from "@/lib/db/schema";
import { and, asc, eq, gt, inArray } from "drizzle-orm";
import { NextResponse } from "next/server";
import { cliJson } from "@/lib/cli/respond";
import { cliJobLogsResponse } from "@/lib/validations/cli-contract";

/** Fetches job logs for a CLI user, with optional pagination via ?after=<id>. */
export async function GET(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id: jobId } = await params;

	const auth = await authorizeCli(req, "view", { type: "job", id: jobId });
	if ("error" in auth) return auth.error;
	const { actor } = auth;

	const { searchParams } = new URL(req.url);
	const after = searchParams.get("after");

	try {
		const db = getServiceDb();

		const [job] = await db
			.select({ id: jobs.id })
			.from(jobs)
			// THE SAME ORG LIST `GET /api/jobs` USES, from the guard rather than re-derived here.
			// It was `eq(jobs.org_id, actor.orgId)`, one element narrower than the list — so a
			// session member of a Teams org could LIST a pre-#3942 runner job (whose `org_id` is
			// their own personal org) and then 404 trying to follow the logs of the id it had just been
			// shown. `alethia jobs logs --latest` reaches exactly that.
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

		const logs = await db
			.select()
			.from(jobLogs)
			.where(
				after
					? and(eq(jobLogs.job_id, jobId), gt(jobLogs.id, parseInt(after, 10)))
					: eq(jobLogs.job_id, jobId),
			)
			.orderBy(asc(jobLogs.id));

		return cliJson(cliJobLogsResponse, { logs });
	} catch (err: unknown) {
		const message =
			err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
