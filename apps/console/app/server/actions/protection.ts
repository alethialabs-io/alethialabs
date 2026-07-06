"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Per-environment protection rules (Phase 2). Read/write the toggleable gates that guard promotions
// into an environment. Evaluated by lib/promotions/gates.ts when a promotion's PLAN completes.

import { eq } from "drizzle-orm";
import { authorize } from "@/lib/authz/guard";
import { withOwnerScope } from "@/lib/db";
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
	return withOwnerScope(actor.userId, async (tx) => {
		const [row] = await tx
			.select()
			.from(environmentProtectionRules)
			.where(eq(environmentProtectionRules.environment_id, envId))
			.limit(1);
		return row ?? null;
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
	return withOwnerScope(owner, async (tx) => {
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
