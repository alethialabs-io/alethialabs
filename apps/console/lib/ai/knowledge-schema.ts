// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The pinned-knowledge document schema (zod SSOT), shared by the `upsertAgentContext` server
// action and the e2e fixtures that seed `agent_context.documents`. Kept out of the "use server"
// module (those may only export async functions), the way `artifact-spec.ts` was split out.
//
// It imports the limit from `knowledge-limits.ts`, not `project-knowledge.ts`: the latter reaches
// into the DB, and this module must stay importable from a fixture or a client component.

import { z } from "zod";
import { KNOWLEDGE_LIMIT } from "@/lib/ai/knowledge-limits";
import type { KnowledgeDoc } from "@/types/jsonb.types";

/** One pinned knowledge document. Titles are required — an unnamed doc is unusable in a list. */
export const documentSchema = z.object({
	id: z.string().min(1),
	title: z.string().trim().min(1).max(200),
	content: z.string().max(KNOWLEDGE_LIMIT),
	updated_at: z.string(),
});

// Compile-time lockstep with the JSONB interface, both directions (same pattern as
// artifact-spec.ts): a key added to one and not the other fails to compile here.
type _DocMatches = KnowledgeDoc extends z.infer<typeof documentSchema>
	? z.infer<typeof documentSchema> extends KnowledgeDoc
		? true
		: never
	: never;
const _docMatches: _DocMatches = true;
void _docMatches;
