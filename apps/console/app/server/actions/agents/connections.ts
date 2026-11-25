"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Disconnecting one of your own connected agents in the addressed org (AGT-L2, gap G8's revoke half).
// Only your own: lib/agents/grants.ts names you and the org in every statement, and the grants' row
// security requires both again. Recorded in Activity under the app's name.

import { z } from "zod";
import { defineAction } from "@/lib/actions/define-action";
import { ActionRefusal, type ActionResult } from "@/lib/actions/result";
import { agentAppIdentity } from "@/lib/agents/catalog";
import { revokeAgentGrant } from "@/lib/agents/grants";
import { recordActivity } from "@/lib/authz/activity";
import { authorizeQuiet } from "@/lib/authz/guard";
import { withActorScope } from "@/lib/db";

const disconnectInput = z.object({ grantId: z.uuid() });

/** Disconnects grant `grantId` of the signed-in person in the addressed org. */
export async function disconnectAgent(raw: z.input<typeof disconnectInput>): Promise<ActionResult<{ grantId: string }>> {
	return defineAction({
		input: disconnectInput,
		run: async ({ input }) => {
			const actor = await authorizeQuiet("view", { type: "org" });
			const clientId = await withActorScope(actor, (tx) => revokeAgentGrant(tx, actor.orgId, actor.userId, input.grantId));
			if (!clientId) throw new ActionRefusal("not-found", "That connection isn't active.");
			recordActivity(actor, "disconnect_agent", { type: "agent_grant", id: input.grantId }, {
				resourceName: agentAppIdentity({ clientId, name: null, icon: null }).name,
			});
			return { grantId: input.grantId };
		},
	})(raw);
}
