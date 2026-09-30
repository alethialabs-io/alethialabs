// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The promotion LIFECYCLE — the service-role half of environment promotion: evaluate a promotion's
// gates once its PLAN succeeds, record an approval and re-evaluate, finalize or fail it when its job
// ends. The user-facing half (promote, preview, approve, reject, cancel, read) stays in
// app/server/actions/promotions.ts, where every export authorizes its caller.
//
// # Why this is NOT in app/server/actions/promotions.ts
//
// None of these functions resolves an actor or asks the PDP — their callers are the job-status route
// (which authenticates the runner token first), `approvePromotion` (which authorizes the approver
// first), and the BYOC B6.1 e2e shim (scripts/e2e/promotion-gate.ts). Two things went wrong while
// they sat in the `"use server"` file:
//
// 1. `"use server"` is FILE-level, so every export was a POST-addressable Server Action.
//    `applyPromotionApproval(promotionId, approverUserId)` records an approval AS ANY USER ID and can
//    enqueue a DEPLOY; `advancePromotionOnPlan(jobId)` can enqueue one too. Same class as #2838, which
//    moved finalizeDeployment / enqueueDeployAfterBuild / recordProbeResult out for the same reason.
// 2. The actions file imports lib/authz/guard → lib/auth/owner → lib/auth, and lib/auth validates
//    BETTER_AUTH_SECRET / BETTER_AUTH_URL at MODULE LOAD. So a process that needs no session — the
//    B6.1 shim — threw "Invalid auth configuration" before it ran a line, and the merge-queue B6.1
//    step was red on every run from the day that job first executed.
//
// Keep this module's import graph free of lib/auth and lib/authz/guard, and never add `"use server"`.
// tests/lib/promotions/lifecycle-import.test.ts holds that line.

import { and, desc, eq, inArray } from "drizzle-orm";
import { signedJob } from "@/lib/db/signed-job";
import { assertJobQuotaAllowed } from "@/lib/billing/job-quota";
import { getPreviousEnvironmentCost } from "@/lib/cost/previous-environment-cost";
import { getServiceDb } from "@/lib/db";
import { transitionEnv } from "@/lib/db/env-status";
import {
	environmentCost,
	environmentDrift,
	environmentPromotions,
	environmentProtectionRules,
	jobs,
	projectEnvironments,
	promotionApprovals,
} from "@/lib/db/schema";
import { notifyScaler } from "@/lib/scaler";
import {
	applyClassificationEnforcement,
	evaluateGates,
	type GateContext,
	type PromotionRules,
} from "@/lib/promotions/gates";
import { claimApprovalSlot } from "@/lib/promotions/approve";
import { getEnforcingValuesFor } from "@/lib/queries/classification";

/** Promotion statuses considered "in flight" (a promotion is still resolving). */
export const IN_FLIGHT = ["PENDING_PLAN", "PENDING_APPROVAL", "APPROVED", "DEPLOYING"] as const;

/** A row of `environment_promotions`. */
export type PromotionRow = typeof environmentPromotions.$inferSelect;
/** A row of `environment_protection_rules`. */
export type ProtectionRow = typeof environmentProtectionRules.$inferSelect;
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

/** Projects a protection-rule row onto the toggleable rule subset the gate engine reads. */
function toRules(rulesRow: ProtectionRow): PromotionRules {
	return {
		require_predecessor: rulesRow.require_predecessor,
		require_verify_pass: rulesRow.require_verify_pass,
		require_approval: rulesRow.require_approval,
		soak_minutes: rulesRow.soak_minutes,
		cost_delta_threshold: rulesRow.cost_delta_threshold,
	};
}

/**
 * The effective number of approval slots for a promotion into `envId` = the strictest of the env's
 * own `min_count` and every enforcing classification value's `min_approvals`. Shared by the gate
 * context and slot materialization so a classification-forced approval creates the right slot count.
 */
async function effectiveMinApprovals(
	db: ServiceDb,
	envId: string,
	rulesRow: ProtectionRow | null,
): Promise<number> {
	const enforcing = await getEnforcingValuesFor(db, "project_environment", envId);
	const { minApprovals } = applyClassificationEnforcement(
		rulesRow ? toRules(rulesRow) : OPEN_RULES,
		rulesRow?.approvers ?? null,
		enforcing,
	);
	return Math.max(1, minApprovals);
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

/**
 * Records `approverUserId`'s approval on a promotion and re-evaluates its gates — the SERVICE-ROLE
 * body shared by `approvePromotion`. It does NOT authorize: the caller MUST have already verified the
 * actor may approve (as `approvePromotion` does via assertApprover). It claims one slot through the
 * race-safe per-slot CAS, then re-runs the SAME gate evaluation `advancePromotionOnPlan` runs after a
 * PLAN completes — enqueuing the DEPLOY once every gate clears (or re-parking if approvals remain).
 * Extracted as a service-role seam (analogous to advancePromotionOnPlan / finalizePromotionOnDeploy)
 * so the BYOC B6.1 e2e harness can drive the real approval path against Postgres without a session —
 * one source of truth, no divergent reimplementation of the gate logic.
 */
export async function applyPromotionApproval(
	promotionId: string,
	approverUserId: string,
	comment?: string,
): Promise<void> {
	const db = getServiceDb();
	const [promotion] = await db
		.select()
		.from(environmentPromotions)
		.where(eq(environmentPromotions.id, promotionId))
		.limit(1);
	if (!promotion) throw new Error("Promotion not found");
	if (promotion.status !== "PENDING_APPROVAL")
		throw new Error("This promotion is not awaiting approval");

	// Record the approval atomically: a transaction + per-slot CAS so two approvers racing this can
	// never collapse onto the same slot (which silently dropped one SOC2 approval).
	const claim = await claimApprovalSlot(db, promotionId, approverUserId, comment);
	if (claim.outcome === "already_approved")
		throw new Error("You have already approved this promotion");
	if (claim.outcome === "no_slots") throw new Error("No pending approval slots remain");

	const [planJob] = promotion.plan_job_id
		? await db.select().from(jobs).where(eq(jobs.id, promotion.plan_job_id)).limit(1)
		: [];
	if (!planJob) throw new Error("Promotion plan job not found");
	const { ctx, rulesRow } = await buildGateContext(db, promotion, planJob);
	await applyGateDecision(db, promotion, rulesRow, evaluateGates(ctx), planJob);
}

// --- internals ------------------------------------------------------------------------------------

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
	const rawRules: PromotionRules = rulesRow ? toRules(rulesRow) : OPEN_RULES;

	// Fold in classification-driven gates: a value tagged on the TARGET env (e.g. Environment=
	// production) can force approval/verify on top of the env's own rules — the label is the policy.
	const enforcing = await getEnforcingValuesFor(
		db,
		"project_environment",
		promotion.target_environment_id,
	);
	const {
		rules,
		minApprovals,
		reasons: enforcedReasons,
	} = applyClassificationEnforcement(rawRules, rulesRow?.approvers ?? null, enforcing);

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

	// Cost: what this candidate plan priced, against what the TARGET environment cost before it.
	// Both come from `environment_cost`, written whenever a PLAN succeeds. A first-ever pricing has
	// no baseline, so the delta is null and the gate skips — rather than reading "+$412" for a
	// number we simply didn't have before.
	const [planCost] = await db
		.select({ total_monthly: environmentCost.total_monthly })
		.from(environmentCost)
		.where(eq(environmentCost.plan_job_id, promotion.plan_job_id ?? ""))
		.limit(1);
	const priorCost = promotion.plan_job_id
		? await getPreviousEnvironmentCost(
				promotion.target_environment_id,
				promotion.plan_job_id,
			)
		: null;
	const costDelta =
		planCost?.total_monthly != null && priorCost != null
			? planCost.total_monthly - priorCost
			: null;

	// Approvals recorded so far.
	const approvalRows = await db
		.select()
		.from(promotionApprovals)
		.where(eq(promotionApprovals.promotion_id, promotion.id));
	const approved = approvalRows.filter((a) => a.status === "approved").length;
	// Effective count already accounts for require_approval (0 when off) + enforcing values' min.
	const required = minApprovals;

	const ctx: GateContext = {
		rules,
		candidateHash: promotion.candidate_hash ?? "",
		predecessor,
		verifyUnwaivedHardFailures,
		// The cost delta this promotion carries: what the candidate plan priced, minus what the
		// environment cost before it. Both are now persisted (environment_cost, written when a PLAN
		// succeeds), so the cost gate finally EVALUATES — it has been inert since it was written,
		// because this was hardcoded to null with the comment "cost baseline isn't persisted yet".
		// Still null when the environment has never been priced before: that's no baseline, hence no
		// delta, and the gate correctly skips rather than inventing a number.
		costDelta,
		approvals: { approved, required },
		enforcedReasons,
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
		// Move the target env to QUEUED through the CAS FIRST (lib/db/env-status.ts). This runs on the
		// service DB from a runner-callback chain (advancePromotionOnPlan) — NOT a transaction — so on a
		// lost race (the env moved out of a deployable state under the promotion) we must not insert an
		// orphan DEPLOY job: bail without advancing the promotion. transitionEnv logged + alerted, and
		// the B2c reconciler backstop converges any stranded promotion.
		const moved = await transitionEnv(
			db,
			promotion.target_environment_id,
			"enqueueDeploy",
			null,
			{ orgId: promotion.org_id, projectId: promotion.project_id },
		);
		if (!moved) return;
		await assertJobQuotaAllowed(promotion.org_id ?? promotion.user_id);
		// Reuse the plan job's frozen snapshot for an idempotent DEPLOY of the candidate.
		const [job] = await db
			.insert(jobs)
			.values(signedJob({
				user_id: promotion.user_id,
				org_id: promotion.org_id ?? undefined,
				project_id: promotion.project_id,
				environment_id: promotion.target_environment_id,
				cloud_identity_id: planJob.cloud_identity_id,
				job_type: "DEPLOY",
				initiated_by: "user",
				config_snapshot: planJob.config_snapshot,
				plan_job_id: planJob.id,
				status: "QUEUED",
			}))
			.returning({ id: jobs.id });
		await db
			.update(environmentPromotions)
			.set({ status: "DEPLOYING", deploy_job_id: job.id, gate_evaluations: evaluation, updated_at: now })
			.where(eq(environmentPromotions.id, promotion.id));
		notifyScaler();
		return;
	}

	if (evaluation.overall === "pending_approval") {
		// Materialize approval slots the first time a manual-approval gate parks the promotion. The
		// requirement may come from the env's own rule OR a classification value that forced it, so
		// key off the evaluated gate (not just rulesRow.require_approval, which misses classification).
		const approvalPending = evaluation.results.some(
			(r) => r.type === "manual_approval" && r.status === "pending",
		);
		if (approvalPending) {
			const existing = await db
				.select({ id: promotionApprovals.id })
				.from(promotionApprovals)
				.where(eq(promotionApprovals.promotion_id, promotion.id));
			if (existing.length === 0) {
				const count = await effectiveMinApprovals(
					db,
					promotion.target_environment_id,
					rulesRow,
				);
				await db.insert(promotionApprovals).values(
					Array.from({ length: count }, () => ({
						promotion_id: promotion.id,
						project_id: promotion.project_id,
						org_id: promotion.org_id ?? undefined,
						required_role: rulesRow?.approvers?.role ?? null,
					})),
				);
			}
		}
		// Re-park only from a pre-approval state. Now that concurrent quorum is actually reachable
		// (the lost-update fix lets two approvers both land), a stale approver that still evaluates
		// `pending_approval` could otherwise clobber a promotion a faster co-approver already advanced
		// to APPROVED/DEPLOYING — flipping it back to PENDING_APPROVAL while a DEPLOY is enqueued. The
		// predecessor guard makes that a no-op (0 rows) so the deploy stands. PENDING_PLAN is the
		// first-park predecessor; PENDING_APPROVAL is a benign re-eval self-write.
		await db
			.update(environmentPromotions)
			.set({ status: "PENDING_APPROVAL", gate_evaluations: evaluation, updated_at: now })
			.where(
				and(
					eq(environmentPromotions.id, promotion.id),
					inArray(environmentPromotions.status, ["PENDING_PLAN", "PENDING_APPROVAL"]),
				),
			);
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
