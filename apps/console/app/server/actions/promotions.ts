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

import { and, desc, eq, inArray } from "drizzle-orm";
import { arrayIncludes } from "@/lib/type-guards";
import { authorize } from "@/lib/authz/guard";
import { getServiceDb, withActorScope } from "@/lib/db";
import {
	environmentPromotions,
	environmentProtectionRules,
	member,
	projectEnvironments,
	promotionApprovals,
	user,
} from "@/lib/db/schema";
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
import type {
	ApproverSpec,
	GateResult,
	PromotionDiff,
} from "@/types/jsonb.types";
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
 * What {@link promoteEnvironment} answers: the promotion and its PLAN job, or a refusal the user can
 * act on, as a VALUE.
 *
 * WHY A VALUE (#5454). Every refusal here used to be THROWN, and the promote dialog toasted
 * `err.message`. In a production build Next replaces a message thrown out of a `"use server"` export
 * with a digest, so "a promotion can only target an equal or higher stage", "already in progress"
 * and every deploy-time gate the PLAN runs (no cloud account linked, the free daily job quota, a job
 * already in flight…) reached the user as noise. "Environment not found for this project" and an
 * authorization failure still throw: neither is something the person in the dialog can fix.
 */
export type PromoteResult =
	| { ok: true; promotionId: string; planJobId: string }
	| { ok: false; error: string };

/**
 * Promotes `sourceEnvId`'s structural design onto `targetEnvId`: writes the merged candidate into the
 * target (preserving the target's sizing/placement), records the promotion, and queues a PLAN. Gates
 * are evaluated when the PLAN completes (advancePromotionOnPlan). Returns the promotion + plan job ids,
 * or a refusal (see {@link PromoteResult}).
 *
 * When the PLAN itself is refused, the promotion is marked FAILED with the reason and the target's
 * previous design is written back. Before #5454 the refusal was thrown after both writes, which left
 * the promotion PENDING_PLAN with no plan job — holding the one-in-flight-per-target slot — and the
 * target already carrying the source's design, so a retry found "no structural changes to promote".
 */
export async function promoteEnvironment(
	projectId: string,
	sourceEnvId: string,
	targetEnvId: string,
	opts?: { includeRemovals?: boolean; runnerId?: string | null },
): Promise<PromoteResult> {
	const actor = await authorize("deploy", { type: "project", id: projectId });
	const owner = actor.userId;
	if (sourceEnvId === targetEnvId)
		return { ok: false, error: "Source and target environments must differ." };

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
		throw new Error("Environment not found for this project");
	if (STAGE_ORDER[target.stage] < STAGE_ORDER[source.stage])
		return {
			ok: false,
			error: "A promotion can only target an equal or higher stage.",
		};
	if (["QUEUED", "PROVISIONING", "DESTROYING", "DESTROYED"].includes(target.status))
		return {
			ok: false,
			error: `Target environment is ${target.status.toLowerCase()} — try again later.`,
		};

	// Compute the diff + candidate from the two designs.
	const sourceDesign = (await getProjectAsFormData(projectId, sourceEnvId)).formData;
	const targetDesign = (await getProjectAsFormData(projectId, targetEnvId)).formData;
	const includeRemovals = opts?.includeRemovals ?? false;
	const diff = diffDesigns(sourceDesign, targetDesign, includeRemovals);
	if (diffIsEmpty(diff))
		return {
			ok: false,
			error: "No structural changes to promote between these environments.",
		};
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
			return {
				ok: false,
				error: "A promotion into this environment is already in progress.",
			};
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
		return {
			ok: false,
			error: `${planned.error} The promotion was stopped and ${target.name} was left as it was.`,
		};
	}
	await withActorScope(actor, (tx) =>
		tx
			.update(environmentPromotions)
			.set({ plan_job_id: planned.jobId, updated_at: new Date() })
			.where(eq(environmentPromotions.id, promotion.id)),
	);

	return { ok: true, promotionId: promotion.id, planJobId: planned.jobId };
}

/** Computes (without side effects) the promotable diff from source→target, for the promote dialog. */
export async function previewPromotion(
	projectId: string,
	sourceEnvId: string,
	targetEnvId: string,
	includeRemovals = false,
): Promise<PromotionDiff> {
	await authorize("view", { type: "project", id: projectId });
	if (sourceEnvId === targetEnvId)
		return { changes: [], summary: [], include_removals: includeRemovals };
	const source = (await getProjectAsFormData(projectId, sourceEnvId)).formData;
	const target = (await getProjectAsFormData(projectId, targetEnvId)).formData;
	return diffDesigns(source, target, includeRemovals);
}

/** Approves one required slot on a promotion; enqueues the DEPLOY once all gates clear. */
export async function approvePromotion(
	promotionId: string,
	comment?: string,
): Promise<void> {
	const { actor, promotion, rulesRow } = await loadForDecision(promotionId, "deploy");
	if (promotion.status !== "PENDING_APPROVAL")
		throw new Error("This promotion is not awaiting approval");
	await assertApprover(actor, rulesRow);
	// Authorization done → run the shared service-role approval body (claim slot + re-evaluate gates).
	await applyPromotionApproval(promotionId, actor.userId, comment);
}

/** Rejects a promotion (records the decision + cancels it). */
export async function rejectPromotion(
	promotionId: string,
	comment?: string,
): Promise<void> {
	const { actor, promotion, rulesRow } = await loadForDecision(promotionId, "deploy");
	if (promotion.status !== "PENDING_APPROVAL")
		throw new Error("This promotion is not awaiting approval");
	await assertApprover(actor, rulesRow);
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
}

/** Cancels an in-flight promotion (leaves the written candidate design in place). */
export async function cancelPromotion(promotionId: string): Promise<void> {
	const { promotion } = await loadForDecision(promotionId, "deploy");
	if (!arrayIncludes(IN_FLIGHT, promotion.status))
		throw new Error("Only an in-flight promotion can be cancelled");
	await getServiceDb()
		.update(environmentPromotions)
		.set({ status: "CANCELLED", completed_at: new Date(), updated_at: new Date() })
		.where(eq(environmentPromotions.id, promotionId));
}

/** Lists a project's promotions (optionally scoped to a target env), newest first. */
export async function listPromotions(projectId: string, envId?: string | null) {
	const actor = await authorize("view", { type: "project", id: projectId });
	return withActorScope(actor, (tx) =>
		tx
			.select()
			.from(environmentPromotions)
			.where(
				envId
					? and(
							eq(environmentPromotions.project_id, projectId),
							eq(environmentPromotions.target_environment_id, envId),
						)
					: eq(environmentPromotions.project_id, projectId),
			)
			.orderBy(desc(environmentPromotions.created_at)),
	);
}

/** A single promotion with its approval slots. */
export async function getPromotion(promotionId: string) {
	// Read via service role to learn the project, then authorize the caller for it.
	const db = getServiceDb();
	const [promotion] = await db
		.select()
		.from(environmentPromotions)
		.where(eq(environmentPromotions.id, promotionId))
		.limit(1);
	if (!promotion) throw new Error("Promotion not found");
	await authorize("view", { type: "project", id: promotion.project_id });
	const approvals = await db
		.select()
		.from(promotionApprovals)
		.where(eq(promotionApprovals.promotion_id, promotionId));
	return { promotion, approvals };
}

/** One approval slot, enriched with the approver's display name for the UI. */
export interface PromotionApprovalSlot {
	id: string;
	status: "pending" | "approved" | "rejected";
	/** Approver display name; null while the slot is still pending. */
	name: string | null;
	initials: string | null;
	requiredRole: string | null;
	comment: string | null;
	decidedAt: string | null;
}

/** A promotion hydrated for the redesigned panel + detail overlay. */
export interface PromotionDetail {
	id: string;
	status: string;
	sourceName: string;
	targetName: string;
	/** Per-gate results from the stored evaluation ([] until the plan has run). */
	gates: GateResult[];
	overall: string | null;
	approvals: PromotionApprovalSlot[];
	approved: number;
	required: number;
	diff: PromotionDiff | null;
	initiator: string | null;
	createdAt: string;
}

/** Two-letter initials from a display name (e.g. "Ivo Karadzhov" → "IK"). */
function initialsOf(name: string): string {
	const parts = name.trim().split(/\s+/).filter(Boolean);
	if (parts.length === 0) return "?";
	if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
	return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * A promotion hydrated for the UI — gate results (from the stored evaluation), approval slots with
 * the approver's name, the source/target env names, the diff, and the initiator. Gates on project
 * `view`. Used by the active-promotion panel and the detail overlay.
 */
export async function getPromotionDetail(
	promotionId: string,
): Promise<PromotionDetail> {
	const db = getServiceDb();
	const [promotion] = await db
		.select()
		.from(environmentPromotions)
		.where(eq(environmentPromotions.id, promotionId))
		.limit(1);
	if (!promotion) throw new Error("Promotion not found");
	await authorize("view", { type: "project", id: promotion.project_id });

	const [envs, approvalRows] = await Promise.all([
		db
			.select({ id: projectEnvironments.id, name: projectEnvironments.name })
			.from(projectEnvironments)
			.where(
				inArray(projectEnvironments.id, [
					promotion.source_environment_id,
					promotion.target_environment_id,
				]),
			),
		db
			.select({
				id: promotionApprovals.id,
				status: promotionApprovals.status,
				required_role: promotionApprovals.required_role,
				comment: promotionApprovals.comment,
				decided_at: promotionApprovals.decided_at,
				approver_name: user.name,
				approver_email: user.email,
			})
			.from(promotionApprovals)
			.leftJoin(user, eq(user.id, promotionApprovals.decided_by))
			.where(eq(promotionApprovals.promotion_id, promotionId)),
	]);
	const nameOf = (id: string) => envs.find((e) => e.id === id)?.name ?? "—";

	const [initiator] = promotion.user_id
		? await db
				.select({ name: user.name, email: user.email })
				.from(user)
				.where(eq(user.id, promotion.user_id))
				.limit(1)
		: [];

	const approvals: PromotionApprovalSlot[] = approvalRows.map((a) => {
		const display = a.approver_name || a.approver_email || null;
		return {
			id: a.id,
			status: a.status,
			name: display,
			initials: display ? initialsOf(display) : null,
			requiredRole: a.required_role,
			comment: a.comment,
			decidedAt: a.decided_at ? a.decided_at.toISOString() : null,
		};
	});

	return {
		id: promotion.id,
		status: promotion.status,
		sourceName: nameOf(promotion.source_environment_id),
		targetName: nameOf(promotion.target_environment_id),
		gates: promotion.gate_evaluations?.results ?? [],
		overall: promotion.gate_evaluations?.overall ?? null,
		approvals,
		approved: approvals.filter((a) => a.status === "approved").length,
		required: approvals.length,
		diff: promotion.diff_summary ?? null,
		initiator: initiator?.name || initiator?.email || null,
		createdAt: promotion.created_at.toISOString(),
	};
}

// --- internals ------------------------------------------------------------------------------------

/** Loads a promotion + its target rules for a decision action, authorizing the caller for the project. */
async function loadForDecision(
	promotionId: string,
	action: "deploy",
): Promise<{ actor: Actor; promotion: PromotionRow; rulesRow: ProtectionRow | null }> {
	const db = getServiceDb();
	const [promotion] = await db
		.select()
		.from(environmentPromotions)
		.where(eq(environmentPromotions.id, promotionId))
		.limit(1);
	if (!promotion) throw new Error("Promotion not found");
	const actor = await authorize(action, { type: "project", id: promotion.project_id });
	const [rulesRow] = await db
		.select()
		.from(environmentProtectionRules)
		.where(eq(environmentProtectionRules.environment_id, promotion.target_environment_id))
		.limit(1);
	return { actor, promotion, rulesRow: rulesRow ?? null };
}

/** Throws unless the actor may approve promotions into the target env. */
async function assertApprover(actor: Actor, rulesRow: ProtectionRow | null): Promise<void> {
	const spec: ApproverSpec | null = rulesRow?.approvers ?? null;
	// No spec, or an empty spec → any deploy-authorized user may approve.
	if (!spec || (spec.user_ids.length === 0 && !spec.role)) return;
	if (spec.user_ids.includes(actor.userId)) return;
	if (spec.role) {
		const [m] = await getServiceDb()
			.select({ role: member.role })
			.from(member)
			.where(and(eq(member.userId, actor.userId), eq(member.organizationId, actor.orgId)))
			.limit(1);
		if (m && (m.role === spec.role || m.role === "owner" || m.role === "admin")) return;
	}
	throw new Error("You are not an approver for this environment");
}
