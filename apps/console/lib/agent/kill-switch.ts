// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The org's agent kill switch at the in-product agent's tool layer (#7477, "off means off"). When an
// owner turns agent access off, the in-product agent is refused EVERY tool: reads, plans, design
// tools and approval requests, not only applies.
//
// The seam is the tool set the turn route hands the model (lib/agent/turn-route.ts): every route's
// tools — the org agent, the project assistant, an agent identity, support — and every subagent the
// model starts pass through it, so one wrapper covers them all and no tool can be added that skips it.
// The decision itself is policy.ts's `agentAccessRefusal`, the same one table 4.2 answers with.
//
// ONE EXEMPTION (#7646): on the support surface, the tools marked in lib/agent/support-surface.ts
// (the documentation search and the support-case proposal) run while agent access is off, because
// they cannot touch infrastructure. The caller names the surface; the exemption needs the support
// surface AND the marked tool object, so the same tool on the org agent is refused, and an unmarked
// tool on a support turn (its account reads) is refused.
//
// When it is read:
//   - At the start of the turn. Off: the client tools (no `execute`: a proposal the browser renders)
//     are not offered at all, and the system prompt says agent access is off, so the model answers
//     in words instead of spending its steps on refusals.
//   - Before EVERY server tool call, live. A switch turned off mid-turn refuses the next call; a call
//     already running finishes. A job such a call would queue is still gated by the queue gate
//     (lib/approvals/gate.ts), which reads the switch again and refuses even an approved request.
//
// A connected agent (MCP, `agent_oauth`) never reaches this file: the MCP route refuses its whole
// request while the switch is off (lib/ai/mcp/actor.ts), and every MCP call is its own request.

import type { ToolSet } from "ai";
import { readAgentPolicy } from "@/lib/approvals/context";
import { AGENT_ACCESS_DISABLED_MESSAGE, agentAccessRefusal, isAgentCredential } from "@/lib/approvals/policy";
import type { Actor } from "@/lib/authz/types";
import { withActorScope } from "@/lib/db";
import { type AgentSurface, exemptFromAgentAccessSwitch } from "./support-surface";

/** What a refused tool call returns to the model: one sentence it relays to the person. */
export interface AgentAccessRefusedOutput {
	status: "refused";
	code: "agent_access_disabled";
	reason: string;
}

/** The output every tool call returns while agent access is off. */
export const AGENT_ACCESS_REFUSED_OUTPUT: AgentAccessRefusedOutput = {
	status: "refused",
	code: "agent_access_disabled",
	reason: AGENT_ACCESS_DISABLED_MESSAGE,
};

/** The sentence added to the system prompt of an agent turn that starts with agent access off. */
export const AGENT_ACCESS_DISABLED_SYSTEM = `${AGENT_ACCESS_DISABLED_MESSAGE} Every tool is refused for this organization. Tell the user this in one sentence and do not call tools.`;

/**
 * The sentence added instead on the support surface: the support chat keeps working, so it must not
 * tell the person that it is turned off. Only its account reads are refused.
 */
export const AGENT_ACCESS_DISABLED_SUPPORT_SYSTEM =
	"In this organization the tools that read the user's account are unavailable, by an owner's setting. " +
	"You can still search the documentation and propose a support case. Do not call the other tools: " +
	"answer from the documentation, and propose a support case when the problem needs someone to look at the account.";

/** The sentence a turn on `surface` that starts with agent access off adds to its system prompt. */
export function agentAccessDisabledSystem(surface: AgentSurface): string {
	return surface === "support" ? AGENT_ACCESS_DISABLED_SUPPORT_SYSTEM : AGENT_ACCESS_DISABLED_SYSTEM;
}

/** How the guard reads the switch. A seam for tests; production reads org_agent_policy. */
export interface KillSwitchDeps {
	/** True when `actor`'s org has agent access on. */
	agentAccessEnabled(actor: Actor): Promise<boolean>;
}

/** Reads the org's switch from org_agent_policy under the actor's RLS scope (a missing row is on). */
export const defaultKillSwitchDeps: KillSwitchDeps = {
	agentAccessEnabled: async (actor) =>
		(await withActorScope(actor, (tx) => readAgentPolicy(tx, actor.orgId))).agentAccessEnabled,
};

/** True when the kill switch refuses `actor` now: an agent credential in an org with agent access off. */
export async function agentAccessRefused(actor: Actor, deps: KillSwitchDeps = defaultKillSwitchDeps): Promise<boolean> {
	if (!isAgentCredential(actor.credential)) return false;
	return agentAccessRefusal(actor.credential, { agentAccessEnabled: await deps.agentAccessEnabled(actor) }) !== null;
}

/** The tool set a turn runs with, and whether it started with agent access off. */
export interface GuardedTools {
	tools: ToolSet;
	/** Agent access was off when the turn started: add {@link AGENT_ACCESS_DISABLED_SYSTEM} to the prompt. */
	disabledAtStart: boolean;
}

/**
 * `tools` as `actor` may run them on `surface` under the kill switch. For a credential the switch does
 * not bind (a person's session), `tools` unchanged. For an agent: a tool exempt on `surface`
 * (lib/agent/support-surface.ts) is passed through unchanged; otherwise off at the start drops every
 * client tool, and every server tool is wrapped so it reads the switch before it runs and returns
 * {@link AGENT_ACCESS_REFUSED_OUTPUT} instead while it is off.
 */
export async function guardAgentTools(
	tools: ToolSet,
	actor: Actor,
	surface: AgentSurface,
	deps: KillSwitchDeps = defaultKillSwitchDeps,
): Promise<GuardedTools> {
	if (!isAgentCredential(actor.credential)) return { tools, disabledAtStart: false };
	const disabledAtStart = await agentAccessRefused(actor, deps);
	const guarded: ToolSet = {};
	for (const [name, def] of Object.entries(tools)) {
		if (exemptFromAgentAccessSwitch(def, surface)) {
			guarded[name] = def;
			continue;
		}
		const run = def.execute;
		if (!run) {
			// A client tool: its output comes from the browser, so there is no call here to refuse. Off
			// at the start, it is not offered; turned off mid-turn, what the person then does with the
			// card is their own action, and a job it starts is gated again by the queue gate.
			if (!disabledAtStart) guarded[name] = def;
			continue;
		}
		guarded[name] = {
			...def,
			execute: async (input, options) => {
				if (await agentAccessRefused(actor, deps)) return AGENT_ACCESS_REFUSED_OUTPUT;
				return run(input, options);
			},
		};
	}
	return { tools: guarded, disabledAtStart };
}
