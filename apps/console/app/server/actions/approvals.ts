"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A person approves or rejects an apply approval request (agent surface §4.3). A server action, not an
// API route: only a console browser session decides, so the decision is made where only a session can
// reach. The bearer API (app/api/approvals/**) requests and reads approvals; it never decides them.

import { headers } from "next/headers";
import { z } from "zod";
import { defineAction } from "@/lib/actions/define-action";
import { ActionRefusal, type ActionResult } from "@/lib/actions/result";
import { decideApproval } from "@/lib/approvals/decide";
import { type ApprovalView, viewOf } from "@/lib/approvals/read";
import { ApprovalError } from "@/lib/approvals/refusal";
import { auth } from "@/lib/auth";
import { currentActor } from "@/lib/authz/guard";
import { withActorScope } from "@/lib/db";

const decisionInput = z.object({
	approvalId: z.uuid(),
	decision: z.enum(["approve", "reject"]),
	/** For a destroy: the environment's name, typed by the person. */
	confirmEnvironmentName: z.string().max(200).nullish(),
});

/** The refusal an {@link ApprovalError} is shown as. */
function refusalOf(err: ApprovalError): ActionRefusal {
	return new ActionRefusal(err.code === "not_found" ? "not-found" : "conflict", err.message);
}

/** Records the signed-in person's decision; refuses anyone who is not a person in a console session. */
async function decide(input: z.output<typeof decisionInput>): Promise<ApprovalView> {
	const session = await auth.api.getSession({ headers: await headers() });
	const actor = await currentActor();
	if (!session?.user || actor.userId !== session.user.id || actor.credential !== "session") {
		throw refusalOf(new ApprovalError("not_a_person", "An approval is decided by a person signed in to the console."));
	}
	try {
		const result = await withActorScope(actor, async (tx) => {
			const decided = await decideApproval(
				tx,
				{ actor, sessionId: session.session.id, sessionCreatedAt: new Date(session.session.createdAt) },
				input.approvalId,
				{ decision: input.decision, confirmEnvironmentName: input.confirmEnvironmentName },
			);
			// An expired or superseded approval is marked so in this transaction, which commits; the
			// refusal is raised after it.
			return decided.ok ? { ok: true as const, view: await viewOf(tx, decided.approval) } : decided;
		});
		if (!result.ok) throw result.error;
		return result.view;
	} catch (err) {
		if (err instanceof ApprovalError) throw refusalOf(err);
		throw err;
	}
}

/** {@link decide} through the mutation contract: refusals come back as values. */
export async function decideApplyApproval(raw: z.input<typeof decisionInput>): Promise<ActionResult<ApprovalView>> {
	return defineAction({ input: decisionInput, run: ({ input }) => decide(input) })(raw);
}
