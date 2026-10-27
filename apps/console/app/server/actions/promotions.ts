"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Environment promotion (Phase 2). Promotes a source env's *structural* design changes onto a target
// env, gated by the target's protection rules. Two-phase: promoteEnvironment writes the merged
// candidate into the target + queues a PLAN; on PLAN success the job-status route calls
// advancePromotionOnPlan, which evaluates the gates and either DEPLOYs, waits for approval, or blocks.
// See lib/promotions/{diff,gates}.ts for the pure engines.
//
// Every export here authorizes its caller. The service-role lifecycle (advancePromotionOnPlan,
// applyPromotionApproval, finalizePromotionOnDeploy, failPromotionForJob) lives in
// lib/promotions/lifecycle.ts: in this `"use server"` file each would be a public, unauthorized
// Server Action. Do not move it back, and do not re-export it from here.
//
// THE MUTATION CONTRACT (ADR 0005 D4, #6120). Every export returns `ActionResult<T>` through
// `defineAction`: a refusal the user can act on is an `ActionRefusal` whose sentence reaches the
// dialog verbatim, an unexpected failure is a reference id, and the client wraps each in
// `useActionMutation`. The reads this file used to serve (the promotion list, a promotion's detail,
// the promote dialog's preview) are GET procedures in `lib/rpc/procedures/environments.ts`.

import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { defineAction } from "@/lib/actions/define-action";
import { ActionRefusal, type ActionResult } from "@/lib/actions/result";
import { arrayIncludes } from "@/lib/type-guards";
import { authorize, currentActor } from "@/lib/authz/guard";
import { getServiceDb, withActorScope } from "@/lib/db";
import {
	environmentPromotions,
	environmentProtectionRules,
	member,
	projectEnvironments,
	projects,
	promotionApprovals,
} from "@/lib/db/schema";
import { projectOrgRefusal } from "@/lib/projects/project-org";
import type { EnvironmentStage } from "@/lib/db/schema/enums";
import type { Actor } from "@/lib/authz/types";
import {
	diffDesigns,
	diffIsEmpty,
	mergeChangeset,
	structuralHash,
} from "@/lib/promotions/diff";
import {
	applyPromotionApproval,
	IN_FLIGHT,
	type PromotionRow,
	type ProtectionRow,
} from "@/lib/promotions/lifecycle";
import { promotionInActorOrg } from "@/lib/promotions/org-binding";
import type { ApproverSpec } from "@/types/jsonb.types";
import {
	getProjectAsFormData,
	reconcileEnvironmentComponents,
	tryPlanProject,
} from "./projects";

/** Stage rank — promotions may only move to an equal or higher stage. */
const STAGE_ORDER: Record<EnvironmentStage, number> = {
	development: 0,
	staging: 1,
	production: 2,
};

/**
 * What a queued promotion answers: the promotion and its PLAN job.
 *
 * WHY REFUSALS ARE VALUES (#5454). Every refusal here used to be THROWN, and the promote dialog
 * toasted `err.message`. In a production build Next replaces a message thrown out of a `"use server"`
 * export with a digest, so "a promotion can only target an equal or higher stage", "already in
 * progress" and every deploy-time gate the PLAN runs (no cloud account linked, the free daily job
 * quota, a job already in flight…) reached the user as noise. They are `ActionRefusal`s now, which
 * `defineAction` returns as `{ ok: false, error: { kind: "conflict", message } }` — the sentence
 * survives the production build.
 */
export interface PromoteQueued {
	promotionId: string;
	planJobId: string;
}

/**
 * Promotes `sourceEnvId`'s structural design onto `targetEnvId`: writes the merged candidate into the
 * target (preserving the target's sizing/placement), records the promotion, and queues a PLAN. Gates
 * are evaluated when the PLAN completes (advancePromotionOnPlan). Returns the promotion + plan job ids;
 * a refusal the user can act on is an `ActionRefusal` (see {@link PromoteQueued}).
 *
 * When the PLAN itself is refused, the promotion is marked FAILED with the reason and the target's
 * previous design is written back. Before #5454 the refusal was thrown after both writes, which left
 * the promotion PENDING_PLAN with no plan job — holding the one-in-flight-per-target slot — and the
 * target already carrying the source's design, so a retry found "no structural changes to promote".
 */
async function promote(
	projectId: string,
	sourceEnvId: string,
	targetEnvId: string,
	opts?: { includeRemovals?: boolean; runnerId?: string | null },
): Promise<PromoteQueued> {
	// The project is bound to the ADDRESSED org before the PDP is asked, as every other entry point
	// here does (lib/promotions/org-binding.ts): an org-wide `deploy` grant answers for any project
	// id. A project of the caller's own personal workspace, addressed from a team org, is refused with
	// a sentence the person can act on; any other org's project reads exactly like an unknown id.
	const scope = await currentActor();
	const [project] = await getServiceDb()
		.select({ org_id: projects.org_id })
		.from(projects)
		.where(eq(projects.id, projectId))
		.limit(1);
	const orgRefusal = project ? projectOrgRefusal(project.org_id, scope) : null;
	if (!project || (orgRefusal && project.org_id !== scope.userId))
		throw new ActionRefusal("not-found", "Project not found.");
	if (orgRefusal) throw new ActionRefusal("conflict", orgRefusal);

	const actor = await authorize("deploy", { type: "project", id: projectId });
	const owner = actor.userId;
	if (sourceEnvId === targetEnvId)
		throw new ActionRefusal("conflict", "Source and target environments must differ.");

	// Validate both environments belong to the project + check stage order and target state.
	const { source, target } = await withActorScope(actor, async (tx) => {
		const rows = await tx
			.select()
			.from(projectEnvironments)
			.where(
				and(
					eq(projectEnvironments.project_id, projectId),
					inArray(projectEnvironments.id, [sourceEnvId, targetEnvId]),
				),
			);
		return {
			source: rows.find((r) => r.id === sourceEnvId),
			target: rows.find((r) => r.id === targetEnvId),
		};
	});
	if (!source || !target)
		throw new ActionRefusal("not-found", "Environment not found for this project");
	if (STAGE_ORDER[target.stage] < STAGE_ORDER[source.stage])
		throw new ActionRefusal("conflict", "A promotion can only target an equal or higher stage.");
	if (["QUEUED", "PROVISIONING", "DESTROYING", "DESTROYED"].includes(target.status))
		throw new ActionRefusal(
			"conflict",
			`Target environment is ${target.status.toLowerCase()} — try again later.`,
		);

	// Compute the diff + candidate from the two designs.
	const sourceDesign = (await getProjectAsFormData(projectId, sourceEnvId)).formData;
	const targetDesign = (await getProjectAsFormData(projectId, targetEnvId)).formData;
	const includeRemovals = opts?.includeRemovals ?? false;
	const diff = diffDesigns(sourceDesign, targetDesign, includeRemovals);
	if (diffIsEmpty(diff))
		throw new ActionRefusal(
			"conflict",
			"No structural changes to promote between these environments.",
		);
	const merged = mergeChangeset(sourceDesign, targetDesign, includeRemovals);
	const candidateHash = structuralHash(sourceDesign);

	// Record the promotion first — the one-in-flight-per-target unique index rejects a concurrent
	// promotion here, BEFORE we mutate the target design.
	let promotion: PromotionRow;
	try {
		promotion = await withActorScope(actor, async (tx) => {
			const [row] = await tx
				.insert(environmentPromotions)
				.values({
					project_id: projectId,
					user_id: owner,
					org_id: actor.orgId,
					source_environment_id: sourceEnvId,
					target_environment_id: targetEnvId,
					status: "PENDING_PLAN",
					candidate_hash: candidateHash,
					diff_summary: diff,
				})
				.returning();
			return row;
		});
	} catch (err) {
		if (err instanceof Error && /unique|duplicate|one_active_per_target/i.test(err.message))
			throw new ActionRefusal(
				"conflict",
				"A promotion into this environment is already in progress.",
			);
		throw err;
	}

	// Write the candidate design into the target env, then queue the PLAN for it.
	await reconcileEnvironmentComponents(projectId, targetEnvId, merged);
	const planned = await tryPlanProject(projectId, opts?.runnerId ?? null, targetEnvId);
	if (!planned.ok) {
		// Release the target's in-flight slot first, so a failure writing the design back cannot
		// leave the promotion holding it.
		await withActorScope(actor, (tx) =>
			tx
				.update(environmentPromotions)
				.set({
					status: "FAILED",
					error_message: `The plan was refused: ${planned.error}`,
					completed_at: new Date(),
					updated_at: new Date(),
				})
				.where(eq(environmentPromotions.id, promotion.id)),
		);
		await reconcileEnvironmentComponents(projectId, targetEnvId, targetDesign);
		throw new ActionRefusal(
			"conflict",
			`${planned.error} The promotion was stopped and ${target.name} was left as it was.`,
		);
	}
	await withActorScope(actor, (tx) =>
		tx
			.update(environmentPromotions)
			.set({ plan_job_id: planned.jobId, updated_at: new Date() })
			.where(eq(environmentPromotions.id, promotion.id)),
	);

	return { promotionId: promotion.id, planJobId: planned.jobId };
}

/** A promotion request, as the promote dialog sends it. */
const promoteInput = z.object({
	projectId: z.uuid(),
	sourceEnvId: z.uuid(),
	targetEnvId: z.uuid(),
	includeRemovals: z.boolean().optional(),
	runnerId: z.string().min(1).max(200).nullable().optional(),
});

/**
 * {@link promote} through the mutation contract: refusals come back as values, never as digests.
 * A `"use server"` file exports only async functions, so the contract is applied inside one.
 */
export async function promoteEnvironment(
	raw: z.input<typeof promoteInput>,
): Promise<ActionResult<PromoteQueued>> {
	return defineAction({
		input: promoteInput,
		run: ({ input }) =>
			promote(input.projectId, input.sourceEnvId, input.targetEnvId, {
				includeRemovals: input.includeRemovals,
				runnerId: input.runnerId,
			}),
	})(raw);
}

/** A decision on one promotion, addressed by id; the comment is optional. */
const decisionInput = z.object({
	promotionId: z.uuid(),
	comment: z.string().max(2000).optional(),
});

/** Approves one required slot on a promotion; enqueues the DEPLOY once all gates clear. */
async function approve(promotionId: string, comment?: string): Promise<null> {
	const { actor, promotion, orgId, rulesRow } = await loadForDecision(promotionId);
	if (promotion.status !== "PENDING_APPROVAL")
		throw new ActionRefusal("conflict", "This promotion is not awaiting approval.");
	await assertApprover(actor, orgId, rulesRow);
	// Authorization done → run the shared service-role approval body (claim slot + re-evaluate gates).
	await applyPromotionApproval(promotionId, actor.userId, comment);
	return null;
}

/** {@link approve} through the mutation contract. */
export async function approvePromotion(
	raw: z.input<typeof decisionInput>,
): Promise<ActionResult<null>> {
	return defineAction({
		input: decisionInput,
		run: ({ input }) => approve(input.promotionId, input.comment),
	})(raw);
}

/** Rejects a promotion (records the decision + cancels it). */
async function reject(promotionId: string, comment?: string): Promise<null> {
	const { actor, promotion, orgId, rulesRow } = await loadForDecision(promotionId);
	if (promotion.status !== "PENDING_APPROVAL")
		throw new ActionRefusal("conflict", "This promotion is not awaiting approval.");
	await assertApprover(actor, orgId, rulesRow);
	const db = getServiceDb();
	const [open] = await db
		.select()
		.from(promotionApprovals)
		.where(
			and(
				eq(promotionApprovals.promotion_id, promotionId),
				eq(promotionApprovals.status, "pending"),
			),
		)
		.limit(1);
	if (open)
		await db
			.update(promotionApprovals)
			.set({ status: "rejected", decided_by: actor.userId, comment, decided_at: new Date() })
			.where(eq(promotionApprovals.id, open.id));
	await db
		.update(environmentPromotions)
		.set({
			status: "CANCELLED",
			error_message: comment ? `Rejected: ${comment}` : "Rejected",
			completed_at: new Date(),
			updated_at: new Date(),
		})
		.where(eq(environmentPromotions.id, promotionId));
	return null;
}

/** {@link reject} through the mutation contract. */
export async function rejectPromotion(
	raw: z.input<typeof decisionInput>,
): Promise<ActionResult<null>> {
	return defineAction({
		input: decisionInput,
		run: ({ input }) => reject(input.promotionId, input.comment),
	})(raw);
}

/** Cancels an in-flight promotion (leaves the written candidate design in place). */
async function cancel(promotionId: string): Promise<null> {
	const { promotion } = await loadForDecision(promotionId);
	if (!arrayIncludes(IN_FLIGHT, promotion.status))
		throw new ActionRefusal("conflict", "Only an in-flight promotion can be cancelled.");
	await getServiceDb()
		.update(environmentPromotions)
		.set({ status: "CANCELLED", completed_at: new Date(), updated_at: new Date() })
		.where(eq(environmentPromotions.id, promotionId));
	return null;
}

/** {@link cancel} through the mutation contract. */
export async function cancelPromotion(
	raw: z.input<typeof decisionInput>,
): Promise<ActionResult<null>> {
	return defineAction({
		input: decisionInput,
		run: ({ input }) => cancel(input.promotionId),
	})(raw);
}

// --- internals ------------------------------------------------------------------------------------

/**
 * Loads a promotion of the actor's organization + its target env's rules for a decision action
 * (approve / reject / cancel), authorizing the caller for `deploy` on the project.
 */
async function loadForDecision(promotionId: string): Promise<{
	actor: Actor;
	promotion: PromotionRow;
	orgId: string;
	rulesRow: ProtectionRow | null;
}> {
	const { actor, promotion, orgId } = await promotionInActorOrg(promotionId, "deploy");
	const [rulesRow] = await getServiceDb()
		.select()
		.from(environmentProtectionRules)
		.where(eq(environmentProtectionRules.environment_id, promotion.target_environment_id))
		.limit(1);
	return { actor, promotion, orgId, rulesRow: rulesRow ?? null };
}

/**
 * Throws unless the actor may approve promotions into the target env. A role requirement is checked
 * against the actor's membership in the PROMOTION's organization (`orgId`, from the bound read).
 */
async function assertApprover(
	actor: Actor,
	orgId: string,
	rulesRow: ProtectionRow | null,
): Promise<void> {
	const spec: ApproverSpec | null = rulesRow?.approvers ?? null;
	// No spec, or an empty spec → any deploy-authorized user may approve.
	if (!spec || (spec.user_ids.length === 0 && !spec.role)) return;
	if (spec.user_ids.includes(actor.userId)) return;
	if (spec.role) {
		const [m] = await getServiceDb()
			.select({ role: member.role })
			.from(member)
			.where(and(eq(member.userId, actor.userId), eq(member.organizationId, orgId)))
			.limit(1);
		if (m && (m.role === spec.role || m.role === "owner" || m.role === "admin")) return;
	}
	// A refusal with its sentence, not a bare permission error: the person can see the promotion and
	// may deploy, so "you don't have permission" would not tell them it is the approver list.
	throw new ActionRefusal("conflict", "You are not an approver for this environment.");
}
