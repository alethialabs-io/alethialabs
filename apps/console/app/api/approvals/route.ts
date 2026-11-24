// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// POST /api/approvals — request a person's approval to deploy or destroy a reviewed plan (agent
// surface §4.3). For a CLI bearer: a device login or a service token. It never queues a job; it
// answers the pending approval and the console path where a person decides it. The caller then
// presents the approval's id as `approval_id` to `POST /api/jobs`.

import { NextResponse } from "next/server";
import { z } from "zod";
import { approvalErrorResponse, approvePath, cliApprovalActor } from "@/lib/approvals/http";
import { viewOf } from "@/lib/approvals/read";
import { MAX_REASON_LENGTH, requestApproval } from "@/lib/approvals/request";
import { APPLY_OPERATIONS } from "@/lib/approvals/types";
import { authorizeCli } from "@/lib/authz/guard";
import { withActorScope } from "@/lib/db";

const requestBody = z.object({
	plan_job_id: z.uuid(),
	operation: z.enum(APPLY_OPERATIONS),
	reason: z.string().max(MAX_REASON_LENGTH).nullish(),
});

/** Records (or returns the live) approval request for the calling CLI credential. */
export async function POST(req: Request) {
	// The verb the request unlocks is checked on the plan's project inside requestApproval.
	const auth = await authorizeCli(req, "view", { type: "project" });
	if ("error" in auth) return auth.error;
	const actor = cliApprovalActor(auth);

	const parsed = requestBody.safeParse(await req.json().catch(() => null));
	if (!parsed.success) {
		return NextResponse.json(
			{ error: "Send plan_job_id (a UUID), operation (deploy or destroy) and an optional reason." },
			{ status: 400 },
		);
	}
	try {
		const view = await withActorScope(actor, async (tx) => {
			const approval = await requestApproval(tx, actor, {
				planJobId: parsed.data.plan_job_id,
				operation: parsed.data.operation,
				reason: parsed.data.reason,
			});
			return viewOf(tx, approval);
		});
		return NextResponse.json({ approval: view, approve_path: approvePath(view.id) }, { status: 201 });
	} catch (err) {
		const refused = approvalErrorResponse(err);
		if (refused) return refused;
		throw err;
	}
}
