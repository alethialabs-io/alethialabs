"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Environment promotion (Phase 2). Promotes a source env's *structural* design changes onto a target
// env, gated by the target's protection rules. Two-phase: promoteEnvironment writes the merged
// candidate into the target + queues a PLAN; on PLAN success the job-status route calls
// advancePromotionOnPlan, which evaluates the gates and either DEPLOYs, waits for approval, or blocks.
// See lib/promotions/{diff,gates}.ts for the pure engines.

import { and, desc, eq, inArray } from "drizzle-orm";
import { authorize } from "@/lib/authz/guard";
import { getServiceDb, withOwnerScope } from "@/lib/db";
import {
	environmentDrift,
	environmentPromotions,
	environmentProtectionRules,
	jobs,
	member,
	projectEnvironments,
	promotionApprovals,
	user,
} from "@/lib/db/schema";
import type { EnvironmentStage } from "@/lib/db/schema/enums";
import type { Actor } from "@/lib/authz/types";
import { notifyScaler } from "@/lib/scaler";
import {
	diffDesigns,
	diffIsEmpty,
	mergeChangeset,
	structuralHash,
} from "@/lib/promotions/diff";
import {
	evaluateGates,
	type GateContext,
	type PromotionRules,
} from "@/lib/promotions/gates";
import type {
	ApproverSpec,
	GateResult,
	PromotionDiff,
} from "@/types/jsonb.types";
import {
	getProjectAsFormData,
	planProject,
	reconcileEnvironmentComponents,
} from "./projects";

/** Stage rank — promotions may only move to an equal or higher stage. */
const STAGE_ORDER: Record<EnvironmentStage, number> = {
	development: 0,
	staging: 1,
	production: 2,
};

/** Promotion statuses considered "in flight" (a promotion is still resolving). */
const IN_FLIGHT = ["PENDING_PLAN", "PENDING_APPROVAL", "APPROVED", "DEPLOYING"] as const;

type PromotionRow = typeof environmentPromotions.$inferSelect;
type ProtectionRow = typeof environmentProtectionRules.$inferSelect;
type JobRow = typeof jobs.$inferSelect;
/** The service-role DB handle (RLS-bypassing) used by route-triggered helpers. */
type ServiceDb = ReturnType<typeof getServiceDb>;

/** The always-permissive rule set for an environment with no protection row. */
const OPEN_RULES: PromotionRules = {
	require_predecessor: false,
	require_verify_pass: false,
	require_approval: false,
	soak_minutes: null,
	cost_delta_threshold: null,
};

/**
 * Promotes `sourceEnvId`'s structural design onto `targetEnvId`: writes the merged candidate into the
 * target (preserving the target's sizing/placement), records the promotion, and queues a PLAN. Gates
 * are evaluated when the PLAN completes (advancePromotionOnPlan). Returns the promotion + plan job ids.
 */
export async function promoteEnvironment(
	projectId: string,
	sourceEnvId: string,
	targetEnvId: string,
	opts?: { includeRemovals?: boolean; runnerId?: string | null },
): Promise<{ promotionId: string; planJobId: string }> {
	const actor = await authorize("deploy", { type: "project", id: projectId });
	const owner = actor.userId;
	if (sourceEnvId === targetEnvId)
		throw new Error("Source and target environments must differ");

	// Validate both environments belong to the project + check stage order and target state.
	const { source, target } = await withOwnerScope(owner, async (tx) => {
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
		throw new Error("A promotion can only target an equal or higher stage");
	if (["QUEUED", "PROVISIONING", "DESTROYING", "DESTROYED"].includes(target.status))
		throw new Error(`Target environment is ${target.status.toLowerCase()} — try again later`);

	// Compute the diff + candidate from the two designs.
	const sourceDesign = (await getProjectAsFormData(projectId, sourceEnvId)).formData;
	const targetDesign = (await getProjectAsFormData(projectId, targetEnvId)).formData;
	const includeRemovals = opts?.includeRemovals ?? false;
	const diff = diffDesigns(sourceDesign, targetDesign, includeRemovals);
	if (diffIsEmpty(diff))
		throw new Error("No structural changes to promote between these environments");
	const merged = mergeChangeset(sourceDesign, targetDesign, includeRemovals);
	const candidateHash = structuralHash(sourceDesign);

	// Record the promotion first — the one-in-flight-per-target unique index rejects a concurrent
	// promotion here, BEFORE we mutate the target design.
	let promotion: PromotionRow;
	try {
		promotion = await withOwnerScope(owner, async (tx) => {
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
			throw new Error("A promotion into this environment is already in progress");
		throw err;
	}

	// Write the candidate design into the target env, then queue the PLAN for it.
	await reconcileEnvironmentComponents(projectId, targetEnvId, merged);
	const { jobId } = await planProject(projectId, opts?.runnerId ?? null, targetEnvId);
	await withOwnerScope(owner, (tx) =>
		tx
			.update(environmentPromotions)
			.set({ plan_job_id: jobId, updated_at: new Date() })
			.where(eq(environmentPromotions.id, promotion.id)),
	);

	return { promotionId: promotion.id, planJobId: jobId };
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

/**
 * Evaluates a promotion's gates once its PLAN succeeds (called by the job-status route, service role)
 * and either enqueues the DEPLOY, parks it for approval, or blocks it. No-op if `jobId` isn't a
 * promotion plan or the promotion already advanced.
 */
export async function advancePromotionOnPlan(jobId: string): Promise<void> {
	const db = getServiceDb();
	const [promotion] = await db
		.select()
		.from(environmentPromotions)
		.where(eq(environmentPromotions.plan_job_id, jobId))
		.limit(1);
	if (!promotion || promotion.status !== "PENDING_PLAN") return;
	const [planJob] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
	if (!planJob) return;
	const { ctx, rulesRow } = await buildGateContext(db, promotion, planJob);
	await applyGateDecision(db, promotion, rulesRow, evaluateGates(ctx), planJob);
}

/** Marks a promotion SUCCEEDED when its DEPLOY job succeeds (service role). */
export async function finalizePromotionOnDeploy(jobId: string): Promise<void> {
	const db = getServiceDb();
	const [promotion] = await db
		.select()
		.from(environmentPromotions)
		.where(eq(environmentPromotions.deploy_job_id, jobId))
		.limit(1);
	if (!promotion) return;
	await db
		.update(environmentPromotions)
		.set({ status: "SUCCEEDED", completed_at: new Date(), updated_at: new Date() })
		.where(eq(environmentPromotions.id, promotion.id));
}

/** Marks a promotion FAILED when its PLAN or DEPLOY job fails (service role). */
export async function failPromotionForJob(jobId: string): Promise<void> {
	const db = getServiceDb();
	const [promotion] = await db
		.select()
		.from(environmentPromotions)
		.where(
			// Either phase's job can be the failing one.
			inArray(environmentPromotions.status, [...IN_FLIGHT]),
		)
		.limit(1)
		.then((rows) =>
			rows.filter(
				(r) => r.plan_job_id === jobId || r.deploy_job_id === jobId,
			),
		);
	if (!promotion) return;
	await db
		.update(environmentPromotions)
		.set({
			status: "FAILED",
			error_message: "The promotion's job failed",
			completed_at: new Date(),
			updated_at: new Date(),
		})
		.where(eq(environmentPromotions.id, promotion.id));
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

	const db = getServiceDb();
	// Approve the caller's slot: prefer a slot they haven't already decided; one approval per user.
	const slots = await db
		.select()
		.from(promotionApprovals)
		.where(eq(promotionApprovals.promotion_id, promotionId));
	if (slots.some((s) => s.decided_by === actor.userId && s.status === "approved"))
		throw new Error("You have already approved this promotion");
	const open = slots.find((s) => s.status === "pending");
	if (!open) throw new Error("No pending approval slots remain");
	await db
		.update(promotionApprovals)
		.set({ status: "approved", decided_by: actor.userId, comment, decided_at: new Date() })
		.where(eq(promotionApprovals.id, open.id));

	const [planJob] = promotion.plan_job_id
		? await db.select().from(jobs).where(eq(jobs.id, promotion.plan_job_id)).limit(1)
		: [];
	if (!planJob) throw new Error("Promotion plan job not found");
	const { ctx, rulesRow: freshRules } = await buildGateContext(db, promotion, planJob);
	await applyGateDecision(db, promotion, freshRules, evaluateGates(ctx), planJob);
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
	if (!IN_FLIGHT.includes(promotion.status as (typeof IN_FLIGHT)[number]))
		throw new Error("Only an in-flight promotion can be cancelled");
	await getServiceDb()
		.update(environmentPromotions)
		.set({ status: "CANCELLED", completed_at: new Date(), updated_at: new Date() })
		.where(eq(environmentPromotions.id, promotionId));
}

/** Lists a project's promotions (optionally scoped to a target env), newest first. */
export async function listPromotions(projectId: string, envId?: string | null) {
	const actor = await authorize("view", { type: "project", id: projectId });
	return withOwnerScope(actor.userId, (tx) =>
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

/** Assembles the gate context for a promotion from its plan job + predecessor state. */
async function buildGateContext(
	db: ServiceDb,
	promotion: PromotionRow,
	planJob: JobRow,
): Promise<{ ctx: GateContext; rulesRow: ProtectionRow | null }> {
	const [rulesRow] = await db
		.select()
		.from(environmentProtectionRules)
		.where(eq(environmentProtectionRules.environment_id, promotion.target_environment_id))
		.limit(1);
	const rules: PromotionRules = rulesRow
		? {
				require_predecessor: rulesRow.require_predecessor,
				require_verify_pass: rulesRow.require_verify_pass,
				require_approval: rulesRow.require_approval,
				soak_minutes: rulesRow.soak_minutes,
				cost_delta_threshold: rulesRow.cost_delta_threshold,
			}
		: OPEN_RULES;

	// Predecessor = the source env this promotion came from.
	const [src] = await db
		.select()
		.from(projectEnvironments)
		.where(eq(projectEnvironments.id, promotion.source_environment_id))
		.limit(1);
	const [drift] = await db
		.select()
		.from(environmentDrift)
		.where(eq(environmentDrift.environment_id, promotion.source_environment_id))
		.orderBy(desc(environmentDrift.scanned_at))
		.limit(1);
	const predecessor = src
		? {
				exists: true,
				deployedHash: src.deployed_config_hash,
				// No drift record yet → no evidence of drift, treat as in-sync.
				inSync: drift ? drift.in_sync : true,
				lastDeployedAt: src.last_deployed_at,
			}
		: null;

	// Verify: count hard (fail) controls not waived by an authorized override on the plan job.
	const report = planJob.execution_metadata?.verify_result ?? null;
	const waived = new Set(planJob.verify_override?.controls ?? []);
	const verifyUnwaivedHardFailures = report
		? report.controls.filter((c) => c.status === "fail" && !waived.has(c.id)).length
		: null;

	// Approvals recorded so far.
	const approvalRows = await db
		.select()
		.from(promotionApprovals)
		.where(eq(promotionApprovals.promotion_id, promotion.id));
	const approved = approvalRows.filter((a) => a.status === "approved").length;
	const min = rulesRow?.approvers?.min_count ?? 1;
	const required = rules.require_approval ? min : 0;

	const ctx: GateContext = {
		rules,
		candidateHash: promotion.candidate_hash ?? "",
		predecessor,
		verifyUnwaivedHardFailures,
		// Cost baseline isn't persisted per-env yet, so the cost gate stays inert (skipped) until a
		// prior cost is available; the rule remains toggleable and wires in once cost data flows.
		costDelta: null,
		approvals: { approved, required },
		nowMs: Date.now(),
	};
	return { ctx, rulesRow: rulesRow ?? null };
}

/** Acts on a gate evaluation: enqueue DEPLOY (pass), park for approval (pending), or block. */
async function applyGateDecision(
	db: ServiceDb,
	promotion: PromotionRow,
	rulesRow: ProtectionRow | null,
	evaluation: ReturnType<typeof evaluateGates>,
	planJob: JobRow,
): Promise<void> {
	const now = new Date();
	if (evaluation.overall === "pass") {
		// Reuse the plan job's frozen snapshot for an idempotent DEPLOY of the candidate.
		const [job] = await db
			.insert(jobs)
			.values({
				user_id: promotion.user_id,
				org_id: promotion.org_id ?? undefined,
				project_id: promotion.project_id,
				environment_id: promotion.target_environment_id,
				cloud_identity_id: planJob.cloud_identity_id,
				job_type: "DEPLOY",
				config_snapshot: planJob.config_snapshot,
				plan_job_id: planJob.id,
				status: "QUEUED",
			})
			.returning({ id: jobs.id });
		await db
			.update(projectEnvironments)
			.set({ status: "QUEUED" })
			.where(eq(projectEnvironments.id, promotion.target_environment_id));
		await db
			.update(environmentPromotions)
			.set({ status: "DEPLOYING", deploy_job_id: job.id, gate_evaluations: evaluation, updated_at: now })
			.where(eq(environmentPromotions.id, promotion.id));
		notifyScaler();
		return;
	}

	if (evaluation.overall === "pending_approval") {
		// Materialize approval slots the first time a manual-approval gate parks the promotion.
		if (rulesRow?.require_approval) {
			const existing = await db
				.select({ id: promotionApprovals.id })
				.from(promotionApprovals)
				.where(eq(promotionApprovals.promotion_id, promotion.id));
			if (existing.length === 0) {
				const spec = rulesRow.approvers;
				const count = Math.max(1, spec?.min_count ?? 1);
				await db.insert(promotionApprovals).values(
					Array.from({ length: count }, () => ({
						promotion_id: promotion.id,
						project_id: promotion.project_id,
						org_id: promotion.org_id ?? undefined,
						required_role: spec?.role ?? null,
					})),
				);
			}
		}
		await db
			.update(environmentPromotions)
			.set({ status: "PENDING_APPROVAL", gate_evaluations: evaluation, updated_at: now })
			.where(eq(environmentPromotions.id, promotion.id));
		return;
	}

	// blocked
	const failing = evaluation.results.find((r) => r.status === "fail");
	await db
		.update(environmentPromotions)
		.set({
			status: "BLOCKED",
			gate_evaluations: evaluation,
			error_message: failing?.detail ?? "A protection gate failed",
			updated_at: now,
		})
		.where(eq(environmentPromotions.id, promotion.id));
}
