// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The facts table 4.2 (policy.ts) is answered from, read from the database: the environment's stage,
// the org's agent policy, and whether a service token lists the environment for automatic deploys.

import { and, eq, isNull } from "drizzle-orm";
import type { Actor } from "@/lib/authz/types";
import { cliServiceTokens, orgAgentPolicy, projectEnvironments } from "@/lib/db/schema";
import type { EnvironmentStage } from "@/lib/db/schema/enums";
import type { Executor } from "./binding";
import { type AgentPolicyToggles, DEFAULT_AGENT_POLICY } from "./policy";

/** The org's agent policy as the engine reads it: the table's toggles plus the approval TTL. */
export interface AgentPolicy extends AgentPolicyToggles {
	requireDifferentApprover: boolean;
	approvalTtlMinutes: number;
}

/** The default approval TTL (decision D6) and its ceiling. */
const DEFAULT_APPROVAL_TTL_MINUTES = 60;
const MAX_APPROVAL_TTL_MINUTES = 24 * 60;

/** The org's agent policy; a missing row is every column default. */
export async function readAgentPolicy(db: Executor, orgId: string): Promise<AgentPolicy> {
	const [row] = await db
		.select({
			agent_access_enabled: orgAgentPolicy.agent_access_enabled,
			agents_may_not_apply_to_production: orgAgentPolicy.agents_may_not_apply_to_production,
			require_different_approver: orgAgentPolicy.require_different_approver,
			approval_ttl_minutes: orgAgentPolicy.approval_ttl_minutes,
		})
		.from(orgAgentPolicy)
		.where(eq(orgAgentPolicy.org_id, orgId))
		.limit(1);
	if (!row) {
		return { ...DEFAULT_AGENT_POLICY, requireDifferentApprover: false, approvalTtlMinutes: DEFAULT_APPROVAL_TTL_MINUTES };
	}
	return {
		agentAccessEnabled: row.agent_access_enabled,
		agentsMayNotApplyToProduction: row.agents_may_not_apply_to_production,
		requireDifferentApprover: row.require_different_approver,
		approvalTtlMinutes: Math.min(Math.max(row.approval_ttl_minutes, 1), MAX_APPROVAL_TTL_MINUTES),
	};
}

/** The stage and name of an environment of `projectId`, or null when it is not one of that project's. */
export async function readEnvironment(
	db: Executor,
	projectId: string,
	environmentId: string,
): Promise<{ stage: EnvironmentStage; name: string } | null> {
	const [env] = await db
		.select({ stage: projectEnvironments.stage, name: projectEnvironments.name })
		.from(projectEnvironments)
		.where(and(eq(projectEnvironments.id, environmentId), eq(projectEnvironments.project_id, projectId)))
		.limit(1);
	return env ?? null;
}

/**
 * True when `actor` is a service token that lists `environmentId` in `auto_approve_environment_ids`
 * (decision D2). The token is the one the actor was built from (`actor.credentialRef`), read live so a
 * revoked token or an edited list answers now. False for every other credential kind.
 */
export async function tokenAutoApproves(db: Executor, actor: Actor, environmentId: string): Promise<boolean> {
	if (actor.credential !== "service_token" || !actor.credentialRef) return false;
	const [token] = await db
		.select({ auto_approve_environment_ids: cliServiceTokens.auto_approve_environment_ids })
		.from(cliServiceTokens)
		.where(
			and(
				eq(cliServiceTokens.id, actor.credentialRef),
				eq(cliServiceTokens.organization_id, actor.orgId),
				isNull(cliServiceTokens.revoked_at),
			),
		)
		.limit(1);
	return token?.auto_approve_environment_ids.includes(environmentId) ?? false;
}
