// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The agent scope vocabulary, in a module with NO imports, so a client component can read it.
// `lib/approvals/types.ts` re-exports it, but that module also imports the queue gate, which pulls
// the enterprise policy and through it billing and the database — server-only code that a browser
// bundle cannot build. Import the scopes from here in anything that renders on the client.

/** What a token may be limited to, from least to most. `apply` and `destroy` unlock a request. */
export const AGENT_SCOPES = ["read", "design", "plan", "apply", "destroy"] as const;

/** One of {@link AGENT_SCOPES}. */
export type AgentScope = (typeof AGENT_SCOPES)[number];
