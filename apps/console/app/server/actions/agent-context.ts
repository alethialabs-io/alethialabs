"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Read/write the Elench context row for a scope — the custom instructions + pinned knowledge
// that ride every chat in that scope (the Claude-Projects model). `projectId` null/undefined
// addresses the ORG-level row; a project id addresses that infra project's row. Owner-scoped
// (RLS), so a caller can only ever touch their own.

import { z } from "zod";
import { requireOwner } from "@/lib/auth/owner";
import { withOwnerScope } from "@/lib/db";
import { agentContext } from "@/lib/db/schema";
import type { AgentContext } from "@/lib/db/schema";
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
	const owner = await requireOwner();
	return readAgentContext(owner, scope);
}

/**
 * Create-or-update the context row for a scope. Keyed on the `(org_id, project_id)` unique
 * constraint (NULLS NOT DISTINCT), so the org-level row upserts correctly too.
 */
export async function upsertAgentContext(
	input: AgentContextInput,
): Promise<AgentContext> {
	const { projectId, instructions, documents } = upsertSchema.parse(input);
	const owner = await requireOwner();
	const scope = projectId ?? null;

	// Everything here rides EVERY turn's system prompt, so the total is capped, not just each doc.
	const total = documents.reduce((n, d) => n + d.content.length, 0);
	if (total > KNOWLEDGE_LIMIT) {
		throw new Error(
			`Knowledge is ${total.toLocaleString()} characters — the limit is ${KNOWLEDGE_LIMIT.toLocaleString()}.`,
		);
	}

	return withOwnerScope(owner, async (tx) => {
		const [row] = await tx
			.insert(agentContext)
			.values({
				user_id: owner,
				org_id: owner,
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
	const owner = await requireOwner();
	return buildProjectKnowledge(owner, id);
}
