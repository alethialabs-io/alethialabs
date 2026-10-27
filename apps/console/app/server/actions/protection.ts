"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Per-environment protection rules (Phase 2). Writes the toggleable gates that guard promotions
// into an environment. Evaluated by lib/promotions/gates.ts when a promotion's PLAN completes.
//
// The reads moved to GET procedures (#6120, ADR 0005 D1): one environment's rules and the project's
// summaries are `lib/rpc/procedures/environments.ts`. The write returns `ActionResult` through
// `defineAction` (ADR 0005 D4), so the rules editor shows a refusal's sentence and its field errors.

import { eq } from "drizzle-orm";
import { z } from "zod";
import { defineAction } from "@/lib/actions/define-action";
import { ActionRefusal, type ActionResult } from "@/lib/actions/result";
import { authorize, currentActor } from "@/lib/authz/guard";
import { withActorScope } from "@/lib/db";
import { environmentProtectionRules } from "@/lib/db/schema";
import { assertProjectInActorOrg } from "@/lib/promotions/org-binding";
// Lives outside this module on purpose: every export of a `"use server"` file is a callable server
// action, so a security helper exported from here to make it testable would widen the RPC surface.
import { assertEnvInProject } from "@/lib/promotions/env-ownership";
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

/** One environment's protection-rule summary (for the env-card "gates into this env" chips). */
export interface ProtectionSummary {
	require_predecessor: boolean;
	require_verify_pass: boolean;
	require_approval: boolean;
	min_count: number | null;
	soak_minutes: number | null;
	cost_delta_threshold: number | null;
}

/**
 * Upserts an environment's protection rules (one row per env). The project is bound to the addressed
 * organization before the PDP is asked (an org-wide grant answers `edit` for any project id), and the
 * environment to the project inside the write.
 */
async function writeProtectionRules(
	projectId: string,
	envId: string,
	input: ProtectionRulesInput,
): Promise<null> {
	await assertProjectInActorOrg(await currentActor(), projectId);
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
		await assertEnvInProject(tx, projectId, envId);
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
				// `setWhere` makes the write STRUCTURALLY unable to cross projects, rather than
				// merely checked. assertEnvInProject above already refuses a foreign environment —
				// but that leaves the higher-severity path standing on one line at the top of a
				// callback that does nothing visible on the happy path, which is exactly the kind of
				// line a later refactor moves or drops. With this predicate, a conflicting row
				// belonging to ANOTHER project updates ZERO rows and `.returning()` yields nothing:
				// a distinguishable failure instead of a silent overwrite.
				//
				// It matters more than usual here because the suite that proves the check inherits
				// `describeIfDb` (#2669), which turns an unreachable Postgres into a silent green. A
				// predicate in the statement holds whether or not the test ran.
				setWhere: eq(environmentProtectionRules.project_id, projectId),
			})
			.returning();
		// A foreign environment is already refused above; this is the second wall. If `setWhere`
		// filtered the update out, `.returning()` is empty — surface that instead of handing back
		// `undefined` as though nothing had been asked for.
		if (!row) throw new ActionRefusal("not-found", "Unknown environment for this project");
		return null;
	});
}

/** The rules editor's request: the environment, and its gates as the form validated them. */
const rulesInput = z.object({
	projectId: z.uuid(),
	environmentId: z.uuid(),
	rules: z.object({
		require_predecessor: z.boolean(),
		require_verify_pass: z.boolean(),
		require_approval: z.boolean(),
		approvers: z.object({
			user_ids: z.array(z.string().min(1).max(200)).max(50),
			role: z.string().min(1).max(100).nullable(),
			min_count: z.number().int().min(1, "At least one approval").max(10, "At most ten approvals"),
		}),
		soak_minutes: z.number().int().min(0, "Minutes can't be negative").max(525_600).nullable(),
		cost_delta_threshold: z.number().min(0, "The threshold can't be negative").max(1_000_000_000).nullable(),
	}),
});

/** {@link writeProtectionRules} through the mutation contract. */
export async function setProtectionRules(
	raw: z.input<typeof rulesInput>,
): Promise<ActionResult<null>> {
	return defineAction({
		input: rulesInput,
		run: ({ input }) => writeProtectionRules(input.projectId, input.environmentId, input.rules),
	})(raw);
}
