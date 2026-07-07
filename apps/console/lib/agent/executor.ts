// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Agent stateless executor — deterministic core (elench A3). An agent is DATA
 * (persona + mission + tool-scope + memory namespace); this module builds the
 * scoped system prompt and narrows the tool set per agent. A turn is then run by
 * the AI SDK (the agent route) with these, the agent's memory loaded just-in-time.
 * Keeping the prompt + scoping pure makes the executor testable without a model.
 */

/** The minimal agent identity this module needs (a row from agent_identities). */
export interface AgentPersona {
	persona: string;
	mission: string;
	/** Allowed tool names; empty = all granted tools. */
	tool_scope: string[];
}

/** Compose an agent's persona + mission (+ optional memory summary) into a system prompt. */
export function buildAgentSystemPrompt(
	identity: AgentPersona,
	memorySummary?: string,
): string {
	const parts = [
		identity.persona.trim(),
		"",
		`Mission: ${identity.mission.trim()}`,
		"Stay within your mission and the tools you have been granted. Be terse and concrete; never invent ids or values.",
	];
	if (memorySummary && memorySummary.trim()) {
		parts.push("", "What you remember about this project:", memorySummary.trim());
	}
	return parts.join("\n");
}

/**
 * Narrow a tool set to the agent's tool scope. An empty scope means "all granted"
 * (the agent inherits the surface it was built with); otherwise only listed tools
 * pass — least privilege per agent (deployer / auditor / cost-optimizer roles).
 */
export function scopeToolsToAgent<T extends Record<string, unknown>>(
	tools: T,
	toolScope: string[],
): Partial<T> {
	if (!toolScope || toolScope.length === 0) return { ...tools };
	const allow = new Set(toolScope);
	const out: Partial<T> = {};
	for (const name of Object.keys(tools) as (keyof T & string)[]) {
		if (allow.has(name)) out[name] = tools[name];
	}
	return out;
}
