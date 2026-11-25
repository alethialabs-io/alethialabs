// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The words the service tokens page uses for what the data model stores (AGT-L2 design §4, final
// copy). One table each, so the list, the sheet and the created dialog cannot name a scope or a
// state two ways. Pure and client-safe.

import type { ServiceTokenStatus } from "@/lib/agents/service-tokens";
import type { AgentScope } from "@/lib/approvals/types";
import type { StatusTier } from "@repo/ui/status-badge";

/** Each scope's name and the sentence under its checkbox, in the order the sheet lists them. */
export const SCOPE_TEXT: Record<AgentScope, { label: string; description: string }> = {
	read: { label: "Read", description: "See projects, environments, jobs and logs." },
	design: { label: "Design", description: "Change infrastructure designs. Nothing is created in your cloud." },
	plan: { label: "Plan", description: "Run plans and repository scans." },
	apply: { label: "Deploy", description: "Ask to deploy. A person approves, unless you choose environments below." },
	destroy: { label: "Destroy", description: "Ask to destroy. A person always approves." },
};

/** The scopes a new token starts with: it can read, plan and ask to deploy. */
export const DEFAULT_SCOPES: AgentScope[] = ["read", "plan", "apply"];

/** A token's scopes as the list shows them: "Read, Plan, Deploy". */
export function scopeWords(scopes: readonly AgentScope[]): string {
	return scopes.map((s) => SCOPE_TEXT[s].label).join(", ");
}

/**
 * Each token state as a `StatusBadge`, with an EXPLICIT tier: `expired` and `revoked` are not in
 * `STATUS_TIER`, and the fallback would draw them like an idle runner.
 */
export const TOKEN_STATUS: Record<ServiceTokenStatus, { tier: StatusTier; label: string }> = {
	active: { tier: "active", label: "Active" },
	expired: { tier: "disabled", label: "Expired" },
	revoked: { tier: "disabled", label: "Revoked" },
};

/** The expiry choices, in days; `never` is a token with no expiry. 90 days is the default. */
export const EXPIRY_CHOICES = [
	{ value: "30", label: "In 30 days", days: 30 },
	{ value: "90", label: "In 90 days", days: 90 },
	{ value: "365", label: "In 1 year", days: 365 },
	{ value: "never", label: "Never", days: undefined },
] as const;

/** One of {@link EXPIRY_CHOICES}' values. */
export type ExpiryChoice = (typeof EXPIRY_CHOICES)[number]["value"];

/** The days an expiry choice stands for; undefined for a token that never expires. */
export function expiryDays(choice: ExpiryChoice): number | undefined {
	return EXPIRY_CHOICES.find((c) => c.value === choice)?.days;
}

/** The three lines under the picker, true whatever is chosen. */
export const PICKER_RULES = [
	"Production environments always need a person.",
	"Destroys always need a person, everywhere.",
	"Every automatic deploy is recorded in Activity with this token's name.",
] as const;
