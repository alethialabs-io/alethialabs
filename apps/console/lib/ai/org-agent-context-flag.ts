// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Dark-launch flag for org-shared agent context (the Elench custom instructions + pinned
// knowledge). OFF (default): agent_context is per-user — written under withOwnerScope stamping
// org_id = user_id and read at user scope, so in a Teams org every member has their own private
// row. ON: the org-level row (project_id NULL) and project rows become ORG-shared — reads use
// withActorScope (prefer the org row, fall back to the author's legacy row during transition) and
// writes are org-stamped + gated by the PDP (`org:edit` for the org row, `project:edit` for a
// project row). Off = byte-identical to today; a plain module (not "use server") so both server
// actions and route handlers can import the synchronous check.

/** Whether org-shared agent context (org/project-scoped reads + PDP-gated writes) is enabled. */
export function orgAgentContextEnabled(): boolean {
	return process.env.ALETHIA_ORG_AGENT_CONTEXT_ENABLED === "true";
}
