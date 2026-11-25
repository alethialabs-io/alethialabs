"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Changing the org's agent policy from the settings page (AGT-L2, gap G7). One action, called on each
// switch as it changes: the page saves instantly, so there is no form-wide save. Guarded by
// `org:manage_agents`; each change is one Activity event saying what changed.

import type { z } from "zod";
import { defineAction } from "@/lib/actions/define-action";
import type { ActionResult } from "@/lib/actions/result";
import {
	type AgentPolicySettings,
	agentPolicyPatchSchema,
	describePolicyPatch,
	writeAgentPolicy,
} from "@/lib/agents/policy";
import { emitActionEvent } from "@/lib/alerts/emit";
import { recordActivity } from "@/lib/authz/activity";
import { authorizeDeferred } from "@/lib/authz/guard";
import { withActorScope } from "@/lib/db";

/**
 * Applies a change to the core toggles (agent access, keeping agents off production, how long a
 * request stays open) in the addressed org, and returns the settings after it.
 */
export async function updateAgentPolicy(
	raw: z.input<typeof agentPolicyPatchSchema>,
): Promise<ActionResult<AgentPolicySettings>> {
	return defineAction({
		input: agentPolicyPatchSchema,
		run: async ({ input }) => {
			const actor = await authorizeDeferred("manage_agents", { type: "org" });
			const settings = await withActorScope(actor, (tx) => writeAgentPolicy(tx, actor.orgId, actor.userId, input));
			recordActivity(actor, "update_agent_policy", { type: "org", id: actor.orgId }, { reason: describePolicyPatch(input) });
			emitActionEvent(actor, "manage_agents", { type: "org", id: actor.orgId }, true);
			return settings;
		},
	})(raw);
}
