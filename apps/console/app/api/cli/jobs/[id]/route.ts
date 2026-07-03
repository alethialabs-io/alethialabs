// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { authorizeCli } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";
import { jobs } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { cliJson } from "@/lib/cli/respond";
import { jobWire } from "@/lib/validations/cli-contract";

/** Fetches a single job by ID, enforcing view·job + org scope. */
export async function GET(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id: jobId } = await params;

	const auth = await authorizeCli(req, "view", { type: "job", id: jobId });
	if ("error" in auth) return auth.error;
	const { actor } = auth;

	try {
		const db = getServiceDb();
		const [job] = await db
			.select()
			.from(jobs)
			.where(and(eq(jobs.id, jobId), eq(jobs.org_id, actor.orgId)))
			.limit(1);

		if (!job) {
			return NextResponse.json({ error: "Job not found" }, { status: 404 });
		}

		return cliJson(jobWire, job);
	} catch (err: unknown) {
		const message =
			err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
