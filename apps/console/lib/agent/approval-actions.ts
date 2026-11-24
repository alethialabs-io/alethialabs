"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The approval card's server side (components/agent/approval/**): reading an approval the in-product
// agent requested, with the facts of its plan, and starting the job once a person approved it.
//
// Deciding is not here: the card calls `decideApplyApproval` (app/server/actions/approvals.ts), the one
// decision path, which only a console session reaches and which refuses the requester's own person
// when the org requires a different approver.
//
// Starting is a person's click in the console. The job is queued with the credential that requested
// the approval (`agent_in_app`, bound to the conversation), presenting the approval, so the queue gate
// (lib/approvals/gate.ts) consumes it exactly as it consumes a connected agent's: approved by a person,
// unexpired, unused, bound to the plan digest, and still allowed by the org's agent policy.

import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { tryDestroyProject, tryProvisionProject } from "@/app/server/actions/projects";
import { defineAction } from "@/lib/actions/define-action";
import { ActionRefusal, type ActionResult } from "@/lib/actions/result";
import { type ApprovalView, readApproval } from "@/lib/approvals/read";
import { ApprovalError } from "@/lib/approvals/refusal";
import { runWithActor } from "@/lib/authz/actor-context";
import { currentActor } from "@/lib/authz/guard";
import { withActorScope } from "@/lib/db";
import { applyApprovals, jobs, projectEnvironments, projects } from "@/lib/db/schema";
import { parseCostBreakdown } from "@/lib/plan/parse-cost";
import { parsePlanJSON } from "@/lib/plan/parse-plan";
import type { VerifyStatus } from "@/types/jsonb.types";
import { inAppAgentActor } from "./in-app-credential";

const approvalInput = z.object({ approvalId: z.uuid() });

/** What the plan an approval is bound to would do, read from the plan job — never the agent's account. */
interface ApprovalPlanFacts {
	projectName: string | null;
	environmentName: string | null;
	/** Resources the plan adds, changes (in place or replaced) and destroys; null when it reported none. */
	add: number | null;
	change: number | null;
	destroy: number | null;
	/** The plan's total monthly cost in major units, when the cost estimate ran. */
	monthly: number | null;
	verifyVerdict: VerifyStatus | null;
}

/** An approval as the in-conversation card renders it. */
export interface InAppApprovalDetail {
	approval: ApprovalView;
	plan: ApprovalPlanFacts;
	/** The requester's note. UNTRUSTED text, written by the model: rendered as such. */
	reason: string | null;
	/** True when the reader's own assistant requested it, so the reader is the one who can start it. */
	requestedByReader: boolean;
}

/** The refusal an {@link ApprovalError} is shown as. */
function refusalOf(err: ApprovalError): ActionRefusal {
	return new ActionRefusal(err.code === "not_found" ? "not-found" : "conflict", err.message);
}

/** The counts and cost of a plan job's stored output; nulls where the runner reported nothing readable. */
function planFactsOf(meta: (typeof jobs.$inferSelect)["execution_metadata"]): Omit<ApprovalPlanFacts, "projectName" | "environmentName"> {
	// parsePlanJSON is lenient: a malformed plan reads as no changes rather than throwing.
	const c = meta?.plan_result ? parsePlanJSON(meta.plan_result).counts : null;
	const counts = c ? { add: c.create, change: c.update + c.replace, destroy: c.delete } : null;
	const monthly = meta?.cost_breakdown ? parseCostBreakdown(meta.cost_breakdown).totalMonthlyCost : null;
	return {
		add: counts?.add ?? null,
		change: counts?.change ?? null,
		destroy: counts?.destroy ?? null,
		monthly,
		verifyVerdict: meta?.verify_result?.verdict ?? null,
	};
}

/** Approval `approvalId` with its plan's facts, for a reader in its org who may view the project. */
async function read(input: z.output<typeof approvalInput>): Promise<InAppApprovalDetail> {
	const actor = await currentActor();
	try {
		return await withActorScope(actor, async (tx) => {
			// The org and the project's `view` verb are checked here; a miss is `not_found`.
			const approval = await readApproval(tx, actor, input.approvalId);
			const [row] = await tx
				.select({
					reason: applyApprovals.reason,
					requester_user_id: applyApprovals.requester_user_id,
					requester_credential: applyApprovals.requester_credential,
					execution_metadata: jobs.execution_metadata,
					project_name: projects.project_name,
					environment_name: projectEnvironments.name,
				})
				.from(applyApprovals)
				.leftJoin(jobs, eq(jobs.id, applyApprovals.plan_job_id))
				.leftJoin(projects, eq(projects.id, applyApprovals.project_id))
				.leftJoin(projectEnvironments, eq(projectEnvironments.id, applyApprovals.environment_id))
				.where(and(eq(applyApprovals.id, approval.id), eq(applyApprovals.org_id, actor.orgId)))
				.limit(1);
			if (!row) throw new ApprovalError("not_found", "That approval was not found in this organization.");
			return {
				approval,
				plan: {
					projectName: row.project_name ?? null,
					environmentName: row.environment_name ?? null,
					...planFactsOf(row.execution_metadata),
				},
				reason: row.reason,
				requestedByReader: row.requester_user_id === actor.userId && row.requester_credential === "agent_in_app",
			};
		});
	} catch (err) {
		if (err instanceof ApprovalError) throw refusalOf(err);
		throw err;
	}
}

/** {@link read} through the mutation contract: refusals come back as values. */
export async function readInAppApproval(
	raw: z.input<typeof approvalInput>,
): Promise<ActionResult<InAppApprovalDetail>> {
	return defineAction({ input: approvalInput, run: ({ input }) => read(input) })(raw);
}

/**
 * Queues the deploy or destroy approval `approvalId` covers, for the person whose in-product agent
 * requested it. Only a person in a console session starts it (a tool inside a turn runs as
 * `agent_in_app` and is refused here), and only the requester's own person: the approver may be
 * someone else, but the job is the requester's. The job is queued as the requesting credential with
 * the approval presented, and the queue gate decides whether the approval covers it.
 */
async function start(input: z.output<typeof approvalInput>): Promise<{ jobId: string }> {
	const actor = await currentActor();
	if (actor.credential !== "session") {
		throw new ActionRefusal("conflict", "An approved request is started by a person in the console.");
	}
	const [approval] = await withActorScope(actor, (tx) =>
		tx
			.select({
				id: applyApprovals.id,
				operation: applyApprovals.operation,
				project_id: applyApprovals.project_id,
				environment_id: applyApprovals.environment_id,
				plan_job_id: applyApprovals.plan_job_id,
				requester_user_id: applyApprovals.requester_user_id,
				requester_credential: applyApprovals.requester_credential,
				requester_credential_ref: applyApprovals.requester_credential_ref,
			})
			.from(applyApprovals)
			.where(and(eq(applyApprovals.id, input.approvalId), eq(applyApprovals.org_id, actor.orgId)))
			.limit(1),
	);
	if (!approval) throw new ActionRefusal("not-found", "That approval was not found in this organization.");
	if (
		approval.requester_credential !== "agent_in_app" ||
		approval.requester_user_id !== actor.userId ||
		!approval.requester_credential_ref
	) {
		throw new ActionRefusal(
			"conflict",
			"Only the person whose assistant requested this can start it, from their conversation.",
		);
	}

	const agent = inAppAgentActor(actor, approval.requester_credential_ref);
	const queued = await runWithActor(agent, () =>
		approval.operation === "deploy"
			? tryProvisionProject(
					approval.project_id,
					approval.plan_job_id,
					undefined,
					approval.environment_id,
					undefined,
					approval.id,
				)
			: tryDestroyProject(approval.project_id, approval.environment_id, undefined, { approvalId: approval.id }),
	);
	if (!queued.ok) throw new ActionRefusal("conflict", queued.error);
	return { jobId: queued.jobId };
}

/** {@link start} through the mutation contract: refusals come back as values. */
export async function startInAppApproval(
	raw: z.input<typeof approvalInput>,
): Promise<ActionResult<{ jobId: string }>> {
	return defineAction({ input: approvalInput, run: ({ input }) => start(input) })(raw);
}
