"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { desc, eq } from "drizzle-orm";
import { memoryNamespace } from "@/lib/agent/memory-path";
import { requireOwner } from "@/lib/auth/owner";
import { withOwnerScope } from "@/lib/db";
import { type AgentIdentity, agentIdentities } from "@/lib/db/schema";

/** Input for creating a scoped agent (elench). */
export interface CreateAgentInput {
	persona: string;
	mission: string;
	/** null/undefined = an org-level agent. */
	projectId?: string | null;
	/** Allowed tool names; empty = all granted. */
	toolScope?: string[];
}

/**
 * Create an owner-scoped agent identity. The agent is DATA (persona + mission +
 * tool-scope + a per-tenant memory namespace); a stateless executor reconstructs
 * its context per turn (lib/agent/executor). The memory namespace is derived (and
 * traversal-guarded) here so memory can never escape the tenant.
 */
export async function createAgent(input: CreateAgentInput): Promise<AgentIdentity> {
	if (!input.persona.trim()) throw new Error("persona is required");
	if (!input.mission.trim()) throw new Error("mission is required");
	const owner = await requireOwner();
	const namespace = memoryNamespace(owner, input.projectId ?? undefined);
	return withOwnerScope(owner, async (tx) => {
		const [agent] = await tx
			.insert(agentIdentities)
			.values({
				user_id: owner,
				org_id: owner,
				project_id: input.projectId ?? null,
				persona: input.persona.trim(),
				mission: input.mission.trim(),
				tool_scope: input.toolScope ?? [],
				memory_namespace: namespace,
			})
			.returning();
		return agent;
	});
}

/** List the owner's agents, newest first. RLS scopes the rows. */
export async function listAgents(): Promise<AgentIdentity[]> {
	const owner = await requireOwner();
	return withOwnerScope(owner, async (tx) =>
		tx.select().from(agentIdentities).orderBy(desc(agentIdentities.created_at)),
	);
}

/** Load one agent identity. */
export async function getAgent(id: string): Promise<AgentIdentity | null> {
	const owner = await requireOwner();
	return withOwnerScope(owner, async (tx) => {
		const [agent] = await tx
			.select()
			.from(agentIdentities)
			.where(eq(agentIdentities.id, id))
			.limit(1);
		return agent ?? null;
	});
}
