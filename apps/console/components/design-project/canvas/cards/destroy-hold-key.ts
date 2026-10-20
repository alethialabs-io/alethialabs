// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The query-key prefix of the held-destroy read (`destroy-hold.tsx`). The tenants a held destroy
 * waits on are OTHER environments, so a change to any environment or job in the org re-asks it:
 * `lib/query/topics.ts` maps the `environments` and `jobs` topics onto this prefix. In its own module
 * so the real-time client imports a constant, not the card's component graph.
 */
export const DESTROY_HOLD_KEY = ["canvas-destroy-hold"] as const;
