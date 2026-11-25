"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Service tokens from the console (AGT-L2, gaps G10 and G11): create one (with the environments it may
// deploy to without a person), change those environments, revoke it. Creating and revoking need
// `org:manage_tokens`, as the CLI's token routes do. Choosing auto-approve environments also needs
// `org:manage_agents` (decision D2, as the verb the owner role carries); the list must pass the rule in
// lib/agents/service-tokens.ts. Every change is recorded in Activity under the token's name.

import { z } from "zod";
import { defineAction } from "@/lib/actions/define-action";
import { ActionRefusal, type ActionResult } from "@/lib/actions/result";
import {
	activeTokenLimits,
	AUTO_APPROVE_REFUSAL_MESSAGES,
	autoApproveFacts,
	autoApproveRefusal,
	writeAutoApprove,
} from "@/lib/agents/service-tokens";
import { AGENT_SCOPES, type AgentScope } from "@/lib/approvals/types";
import { getPdp } from "@/lib/authz";
import { recordActivity, recordAllowed } from "@/lib/authz/activity";
import { authorizeDeferred } from "@/lib/authz/guard";
import type { Actor } from "@/lib/authz/types";
import { ForbiddenError } from "@/lib/authz/types";
import { mintServiceToken, revokeServiceToken } from "@/lib/cli/service-token";

const createInput = z.object({
	name: z.string().trim().min(1, "A token needs a name.").max(120),
	/** The verbs the token may use; omitted means every scope. */
	scopes: z.array(z.enum(AGENT_SCOPES)).min(1).optional(),
	/** The projects it may touch; omitted (or null) means every project of the org. */
	projectIds: z.array(z.uuid()).min(1).max(200).nullish(),
	expiresInDays: z.number().int().positive().max(3650).optional(),
	/** Environments whose deploys go ahead without a person. Needs `org:manage_agents`. */
	autoApproveEnvironmentIds: z.array(z.uuid()).max(200).default([]),
});

const autoApproveInput = z.object({
	tokenId: z.uuid(),
	environmentIds: z.array(z.uuid()).max(200),
});

const revokeInput = z.object({ tokenId: z.uuid() });

/** A freshly created token. `token` is the only time the plaintext exists; the page shows it once. */
export interface CreatedServiceToken {
	id: string;
	name: string;
	tokenPrefix: string;
	token: string;
	scopes: AgentScope[];
	projectIds: string[] | null;
	autoApproveEnvironmentIds: string[];
	expiresAt: string | null;
}

/** Refuses unless `actor` holds `org:manage_agents`; the denial is recorded like any PDP denial. */
async function requireManageAgents(actor: Actor): Promise<void> {
	const decision = await getPdp().can(actor, "manage_agents", { type: "org" });
	if (!decision.allowed) {
		recordActivity(actor, "manage_agents", { type: "org", id: actor.orgId }, { decision: false, reason: decision.reason });
		throw new ForbiddenError("manage_agents", { type: "org" }, decision.reason);
	}
}

/** Refuses an auto-approve list the rule does not allow, with the sentence that says why. */
async function checkAutoApprove(
	actor: Actor,
	environmentIds: readonly string[],
	token: { scopes: readonly AgentScope[]; projectIds: readonly string[] | null },
): Promise<void> {
	const facts = await autoApproveFacts(actor.orgId, environmentIds);
	const refusal = autoApproveRefusal(environmentIds, token, facts);
	if (refusal) throw new ActionRefusal("conflict", AUTO_APPROVE_REFUSAL_MESSAGES[refusal]);
}

/** Creates a service token in the addressed org and returns its plaintext, once. */
export async function createConsoleServiceToken(raw: z.input<typeof createInput>): Promise<ActionResult<CreatedServiceToken>> {
	return defineAction({
		input: createInput,
		run: async ({ input }) => {
			const actor = await authorizeDeferred("manage_tokens", { type: "org" });
			const scopes = input.scopes ?? [...AGENT_SCOPES];
			const projectIds = input.projectIds ?? null;
			const autoApprove = [...new Set(input.autoApproveEnvironmentIds)];
			if (autoApprove.length > 0) {
				await requireManageAgents(actor);
				await checkAutoApprove(actor, autoApprove, { scopes, projectIds });
			}
			const expiresAt = input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86_400_000) : null;
			const minted = await mintServiceToken({
				organizationId: actor.orgId,
				name: input.name,
				createdBy: actor.userId,
				expiresAt,
				ceiling: { scopes, projectIds },
			});
			recordAllowed(actor, "manage_tokens", { type: "org", id: actor.orgId }, {
				recordAs: "create_service_token",
				resourceName: input.name,
			});
			if (autoApprove.length > 0) {
				// Minted first, then given its list, so a failure here leaves a token that asks a person
				// for every deploy — the safe side.
				await writeAutoApprove(actor.orgId, minted.id, autoApprove);
				recordActivity(actor, "set_token_auto_approve", { type: "service_token", id: minted.id }, {
					resourceName: input.name,
					reason: `${autoApprove.length} environment(s) deploy without approval`,
				});
			}
			return {
				id: minted.id,
				name: input.name,
				tokenPrefix: minted.token_prefix,
				token: minted.token,
				scopes,
				projectIds,
				autoApproveEnvironmentIds: autoApprove,
				expiresAt: expiresAt?.toISOString() ?? null,
			};
		},
	})(raw);
}

/**
 * Replaces the environments active token `tokenId` may deploy to without a person. An empty list
 * returns it to asking a person for every deploy. Needs both verbs (see the header).
 */
export async function updateServiceTokenAutoApprove(
	raw: z.input<typeof autoApproveInput>,
): Promise<ActionResult<{ tokenId: string; environmentIds: string[] }>> {
	return defineAction({
		input: autoApproveInput,
		run: async ({ input }) => {
			const actor = await authorizeDeferred("manage_tokens", { type: "org" });
			await requireManageAgents(actor);
			const token = await activeTokenLimits(actor.orgId, input.tokenId);
			if (!token) throw new ActionRefusal("not-found", "That token isn't active in this organization.");
			const environmentIds = [...new Set(input.environmentIds)];
			await checkAutoApprove(actor, environmentIds, token);
			if (!(await writeAutoApprove(actor.orgId, token.id, environmentIds))) {
				throw new ActionRefusal("not-found", "That token isn't active in this organization.");
			}
			recordActivity(actor, "set_token_auto_approve", { type: "service_token", id: token.id }, {
				resourceName: token.name,
				reason: environmentIds.length
					? `${environmentIds.length} environment(s) deploy without approval`
					: "every deploy waits for a person",
			});
			return { tokenId: token.id, environmentIds };
		},
	})(raw);
}

/** Revokes active token `tokenId` in the addressed org. The row is kept for its audit trail. */
export async function revokeConsoleServiceToken(raw: z.input<typeof revokeInput>): Promise<ActionResult<{ tokenId: string }>> {
	return defineAction({
		input: revokeInput,
		run: async ({ input }) => {
			const actor = await authorizeDeferred("manage_tokens", { type: "org" });
			const token = await activeTokenLimits(actor.orgId, input.tokenId);
			if (!token || !(await revokeServiceToken({ id: input.tokenId, organizationId: actor.orgId }))) {
				throw new ActionRefusal("not-found", "That token isn't active in this organization.");
			}
			recordAllowed(actor, "manage_tokens", { type: "org", id: actor.orgId }, {
				recordAs: "revoke_service_token",
				resourceName: token.name,
			});
			return { tokenId: input.tokenId };
		},
	})(raw);
}
