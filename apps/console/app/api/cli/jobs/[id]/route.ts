// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { authorizeCli } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";
import { jobs } from "@/lib/db/schema";
import { and, eq, inArray } from "drizzle-orm";
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
		// THE TENANCY BOUNDARY, and it is TWO orgs wide — the same scope `GET /api/jobs` uses, for
		// the same reason and stated once there rather than twice here (see its `orgScope`).
		// In short: this route reads through `getServiceDb()`, whose role bypasses RLS, so this
		// predicate is the whole of the boundary; a runner-lifecycle job may legitimately carry
		// `org_id = <the caller's personal org>`, whose id IS their user id, and an `org_id`-only
		// clause hides the caller's OWN job from them. #4022 made that reachable on NEW rows too:
		// an unassigned enqueue resolves its stamp from the fleet, so a Teams member on a
		// legacy-only fleet gets a personal-org job — 201 from the enqueue and 404 from here,
		// which is `waitForJob` exiting 1 on a teardown it just queued.
		//
		// IT IS AN `IN` ON ONE COLUMN, NOT A DISJUNCTION. `org_id = <org> OR user_id = <caller>`
		// quotes the `owner_all` RLS policy, and that copy is unsound here: RLS binds
		// `app.current_owner` to the SESSION's human, while for a service token `actor.userId` is
		// whoever MINTED the credential, so an org-unbounded identity arm returns their jobs from
		// every org they belong to through a token pinned to one. Keeping the boundary one column
		// wide leaves no arm for an identity to widen it through.
		const [job] = await db
			.select()
			.from(jobs)
			.where(and(eq(jobs.id, jobId), inArray(jobs.org_id, [actor.orgId, actor.userId])))
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
