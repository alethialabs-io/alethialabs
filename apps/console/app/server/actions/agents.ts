"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { and, desc, eq, or } from "drizzle-orm";
import { memoryNamespace } from "@/lib/agent/memory-path";
import { currentActor } from "@/lib/authz/guard";
import { withScope } from "@/lib/db";
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
	const actor = await currentActor();
	// Tenancy is the caller's active org: the row is stamped with both the creating
	// user and the org so the org-scoped read predicate (see getAgent/listAgents) can
	// find it, and the memory namespace is keyed by the org (never another tenant's).
	const namespace = memoryNamespace(actor.orgId, input.projectId ?? undefined);
	return withScope({ ownerId: actor.userId, orgId: actor.orgId }, async (tx) => {
		const [agent] = await tx
			.insert(agentIdentities)
			.values({
				user_id: actor.userId,
				org_id: actor.orgId,
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

/**
 * List the caller's agents, newest first. Explicitly scoped to the actor's tenancy
 * (own user rows OR the active org's rows) so another org's agents are never
 * returned — agent_identities has no RLS backstop yet, so this predicate is the
 * enforcement point.
 */
export async function listAgents(): Promise<AgentIdentity[]> {
	const actor = await currentActor();
	return withScope({ ownerId: actor.userId, orgId: actor.orgId }, async (tx) =>
		tx
			.select()
			.from(agentIdentities)
			.where(
				or(
					eq(agentIdentities.user_id, actor.userId), // authz-scope-ok: agent_identities has no set_org_id trigger and a nullable org_id, so the user_id arm (a globally-unique id → no cross-tenant match) scopes the actor's OWN rows; the org_id arm scopes Teams. Both keys are the caller's.
					eq(agentIdentities.org_id, actor.orgId),
				),
			)
			.orderBy(desc(agentIdentities.created_at)),
	);
}

/**
 * Load one agent identity, scoped to the caller's tenancy. A request for another
 * org's agent id resolves to null (→ 404 at the call site), never that org's
 * persona/mission. The org predicate is enforced in the query itself (no reliance
 * on RLS, which agent_identities does not yet carry).
 */
export async function getAgent(id: string): Promise<AgentIdentity | null> {
	const actor = await currentActor();
	return withScope({ ownerId: actor.userId, orgId: actor.orgId }, async (tx) => {
		const [agent] = await tx
			.select()
			.from(agentIdentities)
			.where(
				and(
					eq(agentIdentities.id, id),
					or(
						eq(agentIdentities.user_id, actor.userId), // authz-scope-ok: agent_identities has no set_org_id trigger and a nullable org_id, so the user_id arm (a globally-unique id → no cross-tenant match) scopes the actor's OWN rows; the org_id arm scopes Teams. Both keys are the caller's.
						eq(agentIdentities.org_id, actor.orgId),
					),
				),
			)
			.limit(1);
		return agent ?? null;
	});
}
