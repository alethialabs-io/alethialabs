"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Read/write the Elench context row for a scope — the custom instructions + pinned knowledge
// that ride every chat in that scope (the Claude-Projects model). `projectId` null/undefined
// addresses the ORG-level row; a project id addresses that infra project's row.
//
// Scope is dark-flagged by {@link orgAgentContextEnabled} (OFF = byte-identical to the original
// per-user behavior; see the read layer in lib/ai/project-knowledge.ts):
// - OFF: owner-scoped — `requireOwner()` + `withOwnerScope`, `org_id = user_id`; each member only
//   ever touches their own row.
// - ON: ORG-shared. Reads resolve via the actor's org (prefer the org row). Writes are PDP-gated
//   — the org-level row (project_id NULL) needs `org:edit`, a project row needs `project:edit` —
//   run under `withActorScope` and stamp `org_id = actor.orgId` (the org's single row per scope).

import { z } from "zod";
import { requireOwner } from "@/lib/auth/owner";
import { authorize, currentActor } from "@/lib/authz/guard";
import { withActorScope, withOwnerScope } from "@/lib/db";
import { agentContext } from "@/lib/db/schema";
import type { AgentContext } from "@/lib/db/schema";
import { orgAgentContextEnabled } from "@/lib/ai/org-agent-context-flag";
import {
	buildProjectKnowledge,
	KNOWLEDGE_LIMIT,
	readAgentContext,
} from "@/lib/ai/project-knowledge";

const scopeSchema = z.string().uuid().nullish();

/** One pinned knowledge document. Titles are required — an unnamed doc is unusable in a list. */
const documentSchema = z.object({
	id: z.string().min(1),
	title: z.string().trim().min(1).max(200),
	content: z.string().max(KNOWLEDGE_LIMIT),
	updated_at: z.string(),
});

const upsertSchema = z.object({
	projectId: z.string().uuid().nullish(),
	instructions: z.string().max(10_000),
	documents: z.array(documentSchema).max(50),
});

export type AgentContextInput = z.infer<typeof upsertSchema>;

/** The pinned context for a scope (null when nothing has been saved yet). */
export async function getAgentContext(
	projectId?: string | null,
): Promise<AgentContext | null> {
	const scope = scopeSchema.parse(projectId) ?? null;
	// currentActor works for both flag paths: flag-off, readAgentContext uses actor.userId (==
	// requireOwner) under withOwnerScope; flag-on, it scopes to the actor's org. RLS is the wall.
	const actor = await currentActor();
	return readAgentContext(actor, scope);
}

/**
 * Create-or-update the context row for a scope. Keyed on the `(org_id, project_id)` unique
 * constraint (NULLS NOT DISTINCT), so the org-level row upserts correctly too.
 */
export async function upsertAgentContext(
	input: AgentContextInput,
): Promise<AgentContext> {
	const { projectId, instructions, documents } = upsertSchema.parse(input);
	const scope = projectId ?? null;

	// Everything here rides EVERY turn's system prompt, so the total is capped, not just each doc.
	const total = documents.reduce((n, d) => n + d.content.length, 0);
	if (total > KNOWLEDGE_LIMIT) {
		throw new Error(
			`Knowledge is ${total.toLocaleString()} characters — the limit is ${KNOWLEDGE_LIMIT.toLocaleString()}.`,
		);
	}

	if (!orgAgentContextEnabled()) {
		// Legacy per-user path (byte-identical): no PDP gate, org_id = user_id.
		const owner = await requireOwner();
		return withOwnerScope(owner, async (tx) => {
			const [row] = await tx
				.insert(agentContext)
				.values({ user_id: owner, org_id: owner, project_id: scope, instructions, documents })
				.onConflictDoUpdate({
					target: [agentContext.org_id, agentContext.project_id],
					set: { instructions, documents, updated_at: new Date() },
				})
				.returning();
			return row;
		});
	}

	// Org-shared: PDP-gate by scope — the org-level row (the whole org's agent) needs `org:edit`;
	// a project row needs `project:edit`. Stamp org_id = actor.orgId (authoritative for both; a
	// project belongs to the actor's org), so `onConflict [org_id, project_id]` upserts the org's
	// single row and the owner_all WITH CHECK passes via the org arm.
	const actor = scope
		? await authorize("edit", { type: "project", id: scope })
		: await authorize("edit", { type: "org" });
	return withActorScope(actor, async (tx) => {
		const [row] = await tx
			.insert(agentContext)
			.values({
				user_id: actor.userId,
				org_id: actor.orgId,
				project_id: scope,
				instructions,
				documents,
			})
			.onConflictDoUpdate({
				target: [agentContext.org_id, agentContext.project_id],
				set: { instructions, documents, updated_at: new Date() },
			})
			.returning();
		return row;
	});
}

/**
 * The read-only "what Elench already knows" preview shown in the Knowledge panel — the same
 * derived block that rides the project's system prompt.
 */
export async function getProjectKnowledgePreview(
	projectId: string,
): Promise<string> {
	const id = z.string().uuid().parse(projectId);
	const actor = await currentActor();
	return buildProjectKnowledge(actor, id);
}
