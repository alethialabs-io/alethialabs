// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";

/**
 * Zod schema for the assistant's proposed canvas mutations — the single validated
 * contract shared by the `propose_changes` tool (server) and the Ask AI sheet
 * (client parses the tool output before applying). Mirrors the TS types in
 * `components/design-project/canvas/ai/types.ts`.
 */
const NODE_KINDS = [
	"project",
	"cluster",
	"network",
	"database",
	"dns",
	"cache",
	"queue",
	"topic",
	"nosql",
	"secret",
	"service",
	"repositories",
] as const;

export const aiActionSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("add_node"),
		nodeKind: z.enum(NODE_KINDS),
		config: z.record(z.string(), z.unknown()).optional(),
		cloudIdentityId: z.string().nullable().optional(),
	}),
	z.object({
		kind: z.literal("set_identity"),
		nodeId: z.string(),
		cloudIdentityId: z.string().nullable(),
	}),
	z.object({
		kind: z.literal("update_config"),
		nodeId: z.string(),
		patch: z.record(z.string(), z.unknown()),
	}),
	// The assistant could add and reconfigure, but never REMOVE — so "drop the cache, we don't need
	// it" was something it could reason about and not carry out. It's destructive, and therefore
	// exactly as human-gated as everything else here: a PROPOSAL, applied only on accept, and the
	// diff spells out what disappears.
	z.object({
		kind: z.literal("remove_node"),
		nodeId: z.string(),
	}),
]);

export const aiProposalSchema = z.object({
	id: z.string(),
	label: z.string(),
	actions: z.array(aiActionSchema),
});

/** What the model passes to the `propose_changes` tool (id is assigned server-side). */
export const proposeChangesInputSchema = z.object({
	label: z
		.string()
		.describe("Short imperative summary, e.g. 'Add a Postgres database on AWS'"),
	actions: z
		.array(aiActionSchema)
		.min(1)
		.describe("The canvas mutations to apply when the user accepts"),
});

export type AiActionParsed = z.infer<typeof aiActionSchema>;
export type AiProposalParsed = z.infer<typeof aiProposalSchema>;
