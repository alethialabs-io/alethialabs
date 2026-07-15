// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Client-safe knowledge-base constants. These live apart from `project-knowledge.ts` because that
// module reaches into the DB (drizzle + withOwnerScope) — importing it from a client component to
// read one number would drag the whole server graph into the browser bundle.

/**
 * Total characters of pinned knowledge allowed per scope. Everything pinned rides the system
 * prompt of EVERY turn in that scope, so this is a real per-message cost, not just storage —
 * which is why the panel shows it as a capacity meter.
 */
export const KNOWLEDGE_LIMIT = 50_000;
