// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";

// THE AGENT SETTINGS READS (AGT-L2): the org's agent policy, its service tokens and the environments
// their auto-approve picker offers, and the signed-in person's connected agents. Each answer carries
// the capability flags the page needs to decide editability — the page never guesses a permission.
//
//   · policy        — needs `org:view`; `canManage` is `org:manage_agents`.
//   · serviceTokens — needs `org:manage_tokens`; one keyset page of the org's tokens under the
//                     list's filters, with the facets on the first page (lib/queries/service-tokens.ts).
//                     The picker's `org:manage_agents` flag is `readServiceTokenPermissions`, asked by
//                     the route, because a keyset page carries rows and facets only.
//   · tokenEnvironments — needs `org:manage_tokens`.
//   · connected     — needs `org:view`; only the person's own grants, plus the app catalogue.

import { z } from "zod";
import { AGENT_APPS, type AgentApp } from "@/lib/agents/catalog";
import { type ConnectedAgent, listConnectedAgents } from "@/lib/agents/grants";
import { type AgentPolicySettings, APPROVAL_TTL_PRESETS, readAgentPolicySettings } from "@/lib/agents/policy";
import { type TokenProjectChoices, tokenEnvironmentChoices } from "@/lib/agents/service-tokens";
import { readAgentPolicy } from "@/lib/approvals/context";
import { getPdp } from "@/lib/authz";
import { authorizeQuiet } from "@/lib/authz/guard";
import type { Actor } from "@/lib/authz/types";
import { withActorScope } from "@/lib/db";
import { keysetPageInput } from "@/lib/queries/keyset";
import { queryServiceTokensPage, type ServiceTokenPage } from "@/lib/queries/service-tokens";
import { query } from "@/lib/rpc/base";

/** The policy page's answer. */
export interface AgentPolicyRead {
	settings: AgentPolicySettings;
	/** The viewer holds `org:manage_agents`: every core control is editable. */
	canManage: boolean;
	/** The TTL presets offered, in minutes. */
	ttlPresets: readonly number[];
}

/** What the service tokens page may show and change, from the PDP. */
export interface ServiceTokenPermissions {
	/** The viewer holds `org:manage_tokens`: the page lists, creates and revokes tokens. */
	canManageTokens: boolean;
	/** The viewer holds `org:manage_agents`: the auto-approve picker is editable. */
	canManageAgents: boolean;
}

/** The connected-agents board's answer. */
export interface ConnectedAgentsRead {
	connected: ConnectedAgent[];
	/** Every known app, connected or not, in board order. */
	catalog: readonly AgentApp[];
	/** The org's kill switch: off pauses every connected agent. */
	agentAccessEnabled: boolean;
}

/** Whether `actor` holds `org:manage_agents`. A capability flag: asked quietly, recorded nowhere. */
async function holdsManageAgents(actor: Actor): Promise<boolean> {
	return (await getPdp().can(actor, "manage_agents", { type: "org" })).allowed;
}

/**
 * The service tokens route's capability flags, asked quietly (recorded nowhere). Needs `org:view`
 * to ask at all; a viewer without `org:manage_tokens` gets the page's no-access render.
 */
export async function readServiceTokenPermissions(): Promise<ServiceTokenPermissions> {
	const actor = await authorizeQuiet("view", { type: "org" });
	const pdp = getPdp();
	const [tokens, agents] = await Promise.all([
		pdp.can(actor, "manage_tokens", { type: "org" }),
		pdp.can(actor, "manage_agents", { type: "org" }),
	]);
	return { canManageTokens: tokens.allowed, canManageAgents: agents.allowed };
}

/** A facet's selected values, as the URL carries them. */
const facetValues = z.array(z.string().max(64)).max(20).optional();

/** The agent settings domain's reads. */
export const agentsRouter = {
	policy: query.handler(async (): Promise<AgentPolicyRead> => {
		const actor = await authorizeQuiet("view", { type: "org" });
		const settings = await withActorScope(actor, (tx) => readAgentPolicySettings(tx, actor.orgId));
		return { settings, canManage: await holdsManageAgents(actor), ttlPresets: APPROVAL_TTL_PRESETS };
	}),
	serviceTokens: query
		.input(z.object({ status: facetValues, search: z.string().max(200).optional(), ...keysetPageInput() }))
		.handler(async ({ input }): Promise<ServiceTokenPage> => {
			const actor = await authorizeQuiet("manage_tokens", { type: "org" });
			return queryServiceTokensPage(
				actor.orgId,
				{ status: input.status, search: input.search },
				{ cursor: input.cursor, limit: input.limit },
			);
		}),
	tokenEnvironments: query
		.input(z.object({ projectIds: z.array(z.string().uuid()).min(1).max(200).nullish() }))
		.handler(async ({ input }): Promise<TokenProjectChoices[]> => {
			const actor = await authorizeQuiet("manage_tokens", { type: "org" });
			return tokenEnvironmentChoices(actor.orgId, input.projectIds ?? null);
		}),
	connected: query.handler(async (): Promise<ConnectedAgentsRead> => {
		const actor = await authorizeQuiet("view", { type: "org" });
		return withActorScope(actor, async (tx) => ({
			connected: await listConnectedAgents(tx, actor.orgId, actor.userId),
			catalog: AGENT_APPS,
			agentAccessEnabled: (await readAgentPolicy(tx, actor.orgId)).agentAccessEnabled,
		}));
	}),
};
