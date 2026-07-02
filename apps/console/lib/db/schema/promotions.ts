// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Environment promotion + protection rules (Phase 2). A project's environments each own a full
// design; a promotion carries a source env's *structural* changes onto a target env, gated by the
// target's protection rules (predecessor healthy, manual approval, elench verify, soak, cost). The
// flow is two-phase: write candidate → PLAN (verify + cost) → evaluate gates → DEPLOY / await
// approval. See lib/promotions/{diff,gates}.ts and app/server/actions/promotions.ts.

import { sql } from "drizzle-orm";
import {
	boolean,
	index,
	integer,
	jsonb,
	numeric,
	pgTable,
	text,
	timestamp,
	unique,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import type {
	ApproverSpec,
	GateEvaluation,
	PromotionDiff,
} from "@/types/jsonb.types";
import { approvalStatus, promotionStatus } from "./enums";
import { jobs } from "./jobs";
import { projectEnvironments } from "./project-environments";
import { projects } from "./projects";

/**
 * Per-environment protection rules (1:1). Each rule is individually toggleable; a rule that is off
 * (or whose threshold is NULL) is skipped during gate evaluation. Defaults are fully permissive so an
 * environment with no row promotes freely.
 */
export const environmentProtectionRules = pgTable(
	"environment_protection_rules",
	{
		id: uuid().primaryKey().defaultRandom(),
		project_id: uuid()
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		environment_id: uuid()
			.notNull()
			.references(() => projectEnvironments.id, { onDelete: "cascade" }),
		// Coarse tenancy scope (RLS blast wall); community org_id = user_id via trigger.
		user_id: uuid().notNull(),
		org_id: uuid(),
		// (a) The predecessor stage must have deployed THIS design and be in-sync.
		require_predecessor: boolean().default(false).notNull(),
		// (c) The plan's elench verify report must have no unwaived hard failures.
		require_verify_pass: boolean().default(false).notNull(),
		// (b) A human must approve before the deploy runs.
		require_approval: boolean().default(false).notNull(),
		approvers: jsonb()
			.$type<ApproverSpec>()
			.default({ user_ids: [], role: null, min_count: 1 }),
		// (d/soak) Minutes since the predecessor deploy before promote may proceed. NULL = off.
		soak_minutes: integer(),
		// (cost) A plan cost delta above this (USD/mo) flips the promotion to PENDING_APPROVAL. NULL = off.
		cost_delta_threshold: numeric({ precision: 12, scale: 2, mode: "number" }),
		created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
		updated_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [
		unique("environment_protection_rules_env_key").on(t.environment_id),
		index("idx_env_protection_rules_project").on(t.project_id),
	],
);

/**
 * One promotion of a design from a source environment onto a target environment (1:N). Carries the
 * computed diff, the gate evaluation snapshot, and the PLAN/DEPLOY jobs it spawned. A partial unique
 * index enforces at most one in-flight promotion per target env (concurrency guard).
 */
export const environmentPromotions = pgTable(
	"environment_promotions",
	{
		id: uuid().primaryKey().defaultRandom(),
		project_id: uuid()
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		user_id: uuid().notNull(), // initiator
		org_id: uuid(),
		source_environment_id: uuid()
			.notNull()
			.references(() => projectEnvironments.id, { onDelete: "cascade" }),
		target_environment_id: uuid()
			.notNull()
			.references(() => projectEnvironments.id, { onDelete: "cascade" }),
		status: promotionStatus().default("PENDING_PLAN").notNull(),
		// Structural fingerprint of the source design being promoted (lib/promotions structuralHash).
		// Compared against the predecessor env's deployed_config_hash by the predecessor gate.
		candidate_hash: text(),
		// The promotable delta + human summary (lib/promotions/diff.ts).
		diff_summary: jsonb().$type<PromotionDiff>(),
		// Per-rule gate results snapshot, rewritten on each evaluation (lib/promotions/gates.ts).
		gate_evaluations: jsonb().$type<GateEvaluation>(),
		plan_job_id: uuid().references(() => jobs.id, { onDelete: "set null" }),
		deploy_job_id: uuid().references(() => jobs.id, { onDelete: "set null" }),
		error_message: text(),
		created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
		updated_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
		completed_at: timestamp({ withTimezone: true }),
	},
	(t) => [
		index("idx_env_promotions_project").on(t.project_id),
		index("idx_env_promotions_target").on(t.target_environment_id),
		index("idx_env_promotions_plan_job").on(t.plan_job_id),
		index("idx_env_promotions_deploy_job").on(t.deploy_job_id),
		// At most one active promotion per target environment.
		uniqueIndex("env_promotions_one_active_per_target")
			.on(t.target_environment_id)
			.where(
				sql`status in ('PENDING_PLAN','PENDING_APPROVAL','APPROVED','DEPLOYING')`,
			),
	],
);

/**
 * A required approval slot on a promotion (1:N). One row per required decision; created when a
 * promotion enters PENDING_APPROVAL, resolved by an eligible approver.
 */
export const promotionApprovals = pgTable(
	"promotion_approvals",
	{
		id: uuid().primaryKey().defaultRandom(),
		promotion_id: uuid()
			.notNull()
			.references(() => environmentPromotions.id, { onDelete: "cascade" }),
		// RLS scope (mirrors the promotion's project/org).
		project_id: uuid().notNull(),
		org_id: uuid(),
		status: approvalStatus().default("pending").notNull(),
		// Required role for this slot (from ApproverSpec.role); NULL = any listed approver.
		required_role: text(),
		decided_by: uuid(), // user who approved/rejected
		comment: text(),
		created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
		decided_at: timestamp({ withTimezone: true }),
	},
	(t) => [index("idx_promotion_approvals_promotion").on(t.promotion_id)],
);

export type EnvironmentProtectionRules =
	typeof environmentProtectionRules.$inferSelect;
export type NewEnvironmentProtectionRules =
	typeof environmentProtectionRules.$inferInsert;
export type EnvironmentPromotion = typeof environmentPromotions.$inferSelect;
export type NewEnvironmentPromotion = typeof environmentPromotions.$inferInsert;
export type PromotionApproval = typeof promotionApprovals.$inferSelect;
export type NewPromotionApproval = typeof promotionApprovals.$inferInsert;
