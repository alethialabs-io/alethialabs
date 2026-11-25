// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The org's agent policy as the settings page reads and writes it (AGT-L2, gap G7). The engine's own
// reading is lib/approvals/context.ts `readAgentPolicy`, which the gate, the request path and the
// decision re-check share; this module is the settings half: the whole row, who changed it last, and
// the upsert a change makes. A missing row means every default, and the first change inserts it.
//
// WHAT A WRITE MAY CHANGE, by edition: the core toggles — the kill switch, keeping agents off
// production, the approval TTL. "Require a different approver" and the OAuth client allow-list are
// Enterprise (spec §4.9, AGT-L14); their columns are read here so every edition shows them, and their
// write path arrives with that unit's entitlement.
//
// Who may write is `org:manage_agents` (lib/authz/registry.ts), asked by the server action.

import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Executor } from "@/lib/approvals/binding";
import { getServiceDb } from "@/lib/db";
import { orgAgentPolicy, user } from "@/lib/db/schema";

/** The TTL presets the settings page offers, in minutes (spec §3, O5): 15 min to 24 hours. */
export const APPROVAL_TTL_PRESETS = [15, 30, 60, 240, 1440] as const;

/** The approval TTL a missing row means (decision D6). */
const DEFAULT_TTL_MINUTES = 60;

/** The org's agent policy as the settings page shows it. */
export interface AgentPolicySettings {
	agentAccessEnabled: boolean;
	agentsMayNotApplyToProduction: boolean;
	approvalTtlMinutes: number;
	/** Enterprise: the requester's own person may not approve. */
	requireDifferentApprover: boolean;
	/** Enterprise: OAuth client ids allowed to act as agents; null means any app. */
	allowedOauthClientIds: string[] | null;
	/** Who last changed it, and when; null for an org that never changed a default. */
	updatedBy: { id: string; name: string | null } | null;
	updatedAt: string | null;
}

/** The settings a missing row means. */
export const DEFAULT_AGENT_POLICY_SETTINGS: AgentPolicySettings = {
	agentAccessEnabled: true,
	agentsMayNotApplyToProduction: false,
	approvalTtlMinutes: DEFAULT_TTL_MINUTES,
	requireDifferentApprover: false,
	allowedOauthClientIds: null,
	updatedBy: null,
	updatedAt: null,
};

/** The core toggles a write may change. At least one is present. */
export const agentPolicyPatchSchema = z
	.object({
		agentAccessEnabled: z.boolean().optional(),
		agentsMayNotApplyToProduction: z.boolean().optional(),
		approvalTtlMinutes: z
			.number()
			.int()
			.refine((n) => APPROVAL_TTL_PRESETS.some((p) => p === n), "Choose one of the offered durations.")
			.optional(),
	})
	.refine(
		(p) =>
			p.agentAccessEnabled !== undefined ||
			p.agentsMayNotApplyToProduction !== undefined ||
			p.approvalTtlMinutes !== undefined,
		"Nothing to change.",
	);

/** A change to the core toggles. */
export type AgentPolicyPatch = z.output<typeof agentPolicyPatchSchema>;

/**
 * The org's agent policy settings, read through `db` (the viewer's scoped transaction; the row is
 * org-bounded by RLS). The last changer's name is read on the service role for that one id.
 */
export async function readAgentPolicySettings(db: Executor, orgId: string): Promise<AgentPolicySettings> {
	const [row] = await db.select().from(orgAgentPolicy).where(eq(orgAgentPolicy.org_id, orgId)).limit(1);
	if (!row) return DEFAULT_AGENT_POLICY_SETTINGS;
	let updatedBy: AgentPolicySettings["updatedBy"] = null;
	if (row.updated_by) {
		const [person] = await getServiceDb()
			.select({ name: user.name })
			.from(user)
			.where(eq(user.id, row.updated_by))
			.limit(1);
		updatedBy = { id: row.updated_by, name: person?.name ?? null };
	}
	return {
		agentAccessEnabled: row.agent_access_enabled,
		agentsMayNotApplyToProduction: row.agents_may_not_apply_to_production,
		approvalTtlMinutes: row.approval_ttl_minutes,
		requireDifferentApprover: row.require_different_approver,
		allowedOauthClientIds: row.allowed_oauth_client_ids,
		updatedBy,
		updatedAt: row.updated_at.toISOString(),
	};
}

/** The columns a patch sets, with who and when. Only the toggles the patch names are written. */
function patchColumns(patch: AgentPolicyPatch, userId: string) {
	return {
		...(patch.agentAccessEnabled !== undefined ? { agent_access_enabled: patch.agentAccessEnabled } : {}),
		...(patch.agentsMayNotApplyToProduction !== undefined
			? { agents_may_not_apply_to_production: patch.agentsMayNotApplyToProduction }
			: {}),
		...(patch.approvalTtlMinutes !== undefined ? { approval_ttl_minutes: patch.approvalTtlMinutes } : {}),
		updated_by: userId,
	};
}

/**
 * Applies `patch` to `orgId`'s policy as `userId`, inserting the row (with every other column at its
 * default) on the first change. Returns the settings after the change.
 */
export async function writeAgentPolicy(
	db: Executor,
	orgId: string,
	userId: string,
	patch: AgentPolicyPatch,
): Promise<AgentPolicySettings> {
	const columns = patchColumns(patch, userId);
	await db
		.insert(orgAgentPolicy)
		.values({ org_id: orgId, ...columns })
		.onConflictDoUpdate({ target: orgAgentPolicy.org_id, set: { ...columns, updated_at: sql`now()` } });
	return readAgentPolicySettings(db, orgId);
}

/** A short, plain record of what a patch changed, for the Activity line. Names no person. */
export function describePolicyPatch(patch: AgentPolicyPatch): string {
	const parts: string[] = [];
	if (patch.agentAccessEnabled !== undefined) parts.push(`agent access ${patch.agentAccessEnabled ? "on" : "off"}`);
	if (patch.agentsMayNotApplyToProduction !== undefined) {
		parts.push(`agents ${patch.agentsMayNotApplyToProduction ? "kept off" : "allowed on"} production`);
	}
	if (patch.approvalTtlMinutes !== undefined) parts.push(`requests stay open ${patch.approvalTtlMinutes} min`);
	return parts.join("; ");
}
