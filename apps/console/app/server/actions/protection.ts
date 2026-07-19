"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Per-environment protection rules (Phase 2). Read/write the toggleable gates that guard promotions
// into an environment. Evaluated by lib/promotions/gates.ts when a promotion's PLAN completes.

import { eq } from "drizzle-orm";
import { authorize } from "@/lib/authz/guard";
import { withActorScope } from "@/lib/db";
import { environmentProtectionRules } from "@/lib/db/schema";
import type { ApproverSpec } from "@/types/jsonb.types";

/** The editable protection-rule fields for an environment. */
export interface ProtectionRulesInput {
	require_predecessor: boolean;
	require_verify_pass: boolean;
	require_approval: boolean;
	approvers: ApproverSpec;
	/** Minutes to soak since the predecessor deploy; null = off. */
	soak_minutes: number | null;
	/** Cost delta (USD/mo) above which approval is required; null = off. */
	cost_delta_threshold: number | null;
}

/** The target env's protection rules, or null when none are set (fully permissive). */
export async function getProtectionRules(projectId: string, envId: string) {
	const actor = await authorize("view", { type: "project", id: projectId });
	return withActorScope(actor, async (tx) => {
		const [row] = await tx
			.select()
			.from(environmentProtectionRules)
			.where(eq(environmentProtectionRules.environment_id, envId))
			.limit(1);
		return row ?? null;
	});
}

/** One environment's protection-rule summary (for the env-card "gates into this env" chips). */
export interface ProtectionSummary {
	require_predecessor: boolean;
	require_verify_pass: boolean;
	require_approval: boolean;
	min_count: number | null;
	soak_minutes: number | null;
	cost_delta_threshold: number | null;
}

/** All of a project's environments' protection rules, keyed by environment_id (unset → absent). */
export async function listProtectionRules(
	projectId: string,
): Promise<Record<string, ProtectionSummary>> {
	const actor = await authorize("view", { type: "project", id: projectId });
	return withActorScope(actor, async (tx) => {
		const rows = await tx
			.select()
			.from(environmentProtectionRules)
			.where(eq(environmentProtectionRules.project_id, projectId));
		return Object.fromEntries(
			rows.map((r) => [
				r.environment_id,
				{
					require_predecessor: r.require_predecessor,
					require_verify_pass: r.require_verify_pass,
					require_approval: r.require_approval,
					min_count: r.approvers?.min_count ?? null,
					soak_minutes: r.soak_minutes,
					cost_delta_threshold: r.cost_delta_threshold,
				},
			]),
		);
	});
}

/** Upserts an environment's protection rules (one row per env). */
export async function setProtectionRules(
	projectId: string,
	envId: string,
	input: ProtectionRulesInput,
) {
	const actor = await authorize("edit", { type: "project", id: projectId });
	const owner = actor.userId;
	const fields = {
		require_predecessor: input.require_predecessor,
		require_verify_pass: input.require_verify_pass,
		require_approval: input.require_approval,
		approvers: input.approvers,
		soak_minutes: input.soak_minutes,
		cost_delta_threshold: input.cost_delta_threshold,
	};
	return withActorScope(actor, async (tx) => {
		const [row] = await tx
			.insert(environmentProtectionRules)
			.values({
				project_id: projectId,
				environment_id: envId,
				user_id: owner,
				org_id: actor.orgId,
				...fields,
			})
			.onConflictDoUpdate({
				target: environmentProtectionRules.environment_id,
				set: { ...fields, updated_at: new Date() },
			})
			.returning();
		return row;
	});
}
