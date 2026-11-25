// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";

// THE AGENT SETTINGS READS (AGT-L2): the org's agent policy, its service tokens and the environments
// their auto-approve picker offers, and the signed-in person's connected agents. Each answer carries
// the capability flags the page needs to decide editability — the page never guesses a permission.
//
//   · policy        — needs `org:view`; `canManage` is `org:manage_agents`.
//   · serviceTokens — needs `org:manage_tokens`; `canManageAgents` gates the picker.
//   · tokenEnvironments — needs `org:manage_tokens`.
//   · connected     — needs `org:view`; only the person's own grants, plus the app catalogue.

import { z } from "zod";
import { AGENT_APPS, type AgentApp } from "@/lib/agents/catalog";
import { type ConnectedAgent, listConnectedAgents } from "@/lib/agents/grants";
import { type AgentPolicySettings, APPROVAL_TTL_PRESETS, readAgentPolicySettings } from "@/lib/agents/policy";
import {
	type ConsoleServiceToken,
	listConsoleServiceTokens,
	type TokenProjectChoices,
	tokenEnvironmentChoices,
} from "@/lib/agents/service-tokens";
import { readAgentPolicy } from "@/lib/approvals/context";
import { getPdp } from "@/lib/authz";
import { authorizeQuiet } from "@/lib/authz/guard";
import type { Actor } from "@/lib/authz/types";
import { withActorScope } from "@/lib/db";
import { query } from "@/lib/rpc/base";

/** The policy page's answer. */
export interface AgentPolicyRead {
	settings: AgentPolicySettings;
	/** The viewer holds `org:manage_agents`: every core control is editable. */
	canManage: boolean;
	/** The TTL presets offered, in minutes. */
	ttlPresets: readonly number[];
}

/** The service tokens page's answer. */
export interface ServiceTokensRead {
	tokens: ConsoleServiceToken[];
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

/** The agent settings domain's reads. */
export const agentsRouter = {
	policy: query.handler(async (): Promise<AgentPolicyRead> => {
		const actor = await authorizeQuiet("view", { type: "org" });
		const settings = await withActorScope(actor, (tx) => readAgentPolicySettings(tx, actor.orgId));
		return { settings, canManage: await holdsManageAgents(actor), ttlPresets: APPROVAL_TTL_PRESETS };
	}),
	serviceTokens: query.handler(async (): Promise<ServiceTokensRead> => {
		const actor = await authorizeQuiet("manage_tokens", { type: "org" });
		return { tokens: await listConsoleServiceTokens(actor.orgId), canManageAgents: await holdsManageAgents(actor) };
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
