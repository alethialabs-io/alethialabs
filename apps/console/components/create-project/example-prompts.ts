// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A plain module (no "use client"), because the chooser's loading skeleton — a server component —
// renders the same chips as the chooser, from the same text, so they wrap the same (#6131, B2).

/** Example prompts seeding the agent hero. */
export const EXAMPLE_PROMPTS = [
	"An EKS cluster for an AI inference API — autoscaling GPU node pool, Postgres + pgvector, Redis.",
	"A GPU training cluster on AWS — spot node pool, shared storage, a Postgres metadata database.",
	"Postgres + pgvector, Redis, and an object store wired into a small cluster for a RAG backend.",
];

/** The text a prompt's chip shows: the part before the em dash. */
export function examplePromptLabel(prompt: string): string {
	return prompt.split(" — ")[0];
}
