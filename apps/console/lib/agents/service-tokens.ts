// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The service token types the console's settings page reads (the list itself is
// lib/queries/service-tokens.ts, a keyset page), the picker's environments, and the write path for the environments
// a token may deploy to without a person (AGT-L2, gaps G10 and G11; decision D2).
//
// THE AUTO-APPROVE RULE, held here so the database never holds a value the picker could not have
// produced: every environment must belong to a project of the token's org, and to one of the token's
// projects when it is limited to some; none may be a `production` environment; and the token must
// carry the `apply` scope, without which it cannot ask to deploy at all. The engine enforces the
// same limits again at use (lib/approvals/policy.ts grants `automatic` only to a non-production
// DEPLOY, and context.ts `tokenAutoApproves` reads the list live), so this is the second wall, not
// the only one. Destroys always need a person, everywhere.
//
// Who may write is two verbs: `org:manage_tokens` to touch a token at all, and `org:manage_agents`
// to choose its auto-approve environments. The server actions ask both.

import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { AgentScope } from "@/lib/approvals/types";
import { getServiceDb } from "@/lib/db";
import { cliServiceTokens, projectEnvironments, projects } from "@/lib/db/schema";
import type { EnvironmentStage } from "@/lib/db/schema/enums";

/** A token's state, from its revocation and expiry. */
export type ServiceTokenStatus = "active" | "revoked" | "expired";

/** A service token as the settings page lists it (`lib/queries/service-tokens.ts`). Never a secret: the prefix only. */
export interface ConsoleServiceToken {
	id: string;
	name: string;
	tokenPrefix: string;
	scopes: AgentScope[];
	/** null means every project of the org, present and future. */
	projectIds: string[] | null;
	autoApproveEnvironmentIds: string[];
	createdAt: string;
	createdBy: { id: string; name: string | null } | null;
	expiresAt: string | null;
	lastUsedAt: string | null;
	revokedAt: string | null;
	status: ServiceTokenStatus;
}

/** The state of a token at `now`. Revoked wins over expired. */
export function serviceTokenStatus(token: { revoked_at: Date | null; expires_at: Date | null }, now: Date): ServiceTokenStatus {
	if (token.revoked_at) return "revoked";
	if (token.expires_at && token.expires_at.getTime() <= now.getTime()) return "expired";
	return "active";
}

/** One environment the picker offers. */
export interface TokenEnvironmentChoice {
	id: string;
	name: string;
	stage: EnvironmentStage;
}

/** A project's environments, as the picker groups them. */
export interface TokenProjectChoices {
	projectId: string;
	projectName: string;
	environments: TokenEnvironmentChoice[];
}

/**
 * The environments the picker lists for a token limited to `projectIds` (null = every project of the
 * org), grouped by project and in name order. Production rows are included — the picker shows them
 * disabled — so nobody wonders where production went. `projectIds` is intersected with the org's own
 * projects, so an id from another org lists nothing.
 */
export async function tokenEnvironmentChoices(
	orgId: string,
	projectIds: readonly string[] | null,
): Promise<TokenProjectChoices[]> {
	const rows = await getServiceDb()
		.select({
			project_id: projects.id,
			project_name: projects.project_name,
			id: projectEnvironments.id,
			name: projectEnvironments.name,
			stage: projectEnvironments.stage,
		})
		.from(projectEnvironments)
		.innerJoin(projects, eq(projects.id, projectEnvironments.project_id))
		.where(and(eq(projects.org_id, orgId), projectIds ? inArray(projects.id, [...projectIds]) : undefined))
		.orderBy(asc(projects.project_name), asc(projectEnvironments.name));
	const groups = new Map<string, TokenProjectChoices>();
	for (const r of rows) {
		const group = groups.get(r.project_id) ?? { projectId: r.project_id, projectName: r.project_name, environments: [] };
		group.environments.push({ id: r.id, name: r.name, stage: r.stage });
		groups.set(r.project_id, group);
	}
	return [...groups.values()];
}

/** Why an auto-approve list is refused. */
export type AutoApproveRefusal = "needs_apply_scope" | "unknown_environment" | "outside_token_projects" | "production";

/** The sentence each refusal is shown as. */
export const AUTO_APPROVE_REFUSAL_MESSAGES: Record<AutoApproveRefusal, string> = {
	needs_apply_scope: "Deploying without approval needs the Deploy permission on the token.",
	unknown_environment: "One of the chosen environments isn't in this organization.",
	outside_token_projects: "One of the chosen environments isn't in a project this token can use.",
	production: "Production environments always need a person.",
};

/** One chosen environment as the rule reads it. */
export interface AutoApproveEnvironmentFact {
	id: string;
	projectId: string;
	stage: EnvironmentStage;
}

/**
 * Checks an auto-approve list against the rule in the header. Pure: `facts` are the org's rows for the
 * chosen ids (an id with no fact is not in the org). An empty list is always allowed — it is how a
 * token goes back to asking a person for every deploy.
 */
export function autoApproveRefusal(
	chosen: readonly string[],
	token: { scopes: readonly AgentScope[]; projectIds: readonly string[] | null },
	facts: readonly AutoApproveEnvironmentFact[],
): AutoApproveRefusal | null {
	if (chosen.length === 0) return null;
	if (!token.scopes.includes("apply")) return "needs_apply_scope";
	const byId = new Map(facts.map((f) => [f.id, f]));
	for (const id of chosen) {
		const fact = byId.get(id);
		if (!fact) return "unknown_environment";
		if (token.projectIds && !token.projectIds.includes(fact.projectId)) return "outside_token_projects";
		if (fact.stage === "production") return "production";
	}
	return null;
}

/** The org's facts for `environmentIds`: the ones that are environments of a project in `orgId`. */
export async function autoApproveFacts(orgId: string, environmentIds: readonly string[]): Promise<AutoApproveEnvironmentFact[]> {
	if (environmentIds.length === 0) return [];
	return getServiceDb()
		.select({ id: projectEnvironments.id, projectId: projectEnvironments.project_id, stage: projectEnvironments.stage })
		.from(projectEnvironments)
		.innerJoin(projects, eq(projects.id, projectEnvironments.project_id))
		.where(and(eq(projects.org_id, orgId), inArray(projectEnvironments.id, [...environmentIds])));
}

/** An active token of `orgId`, as the auto-approve rule needs it; null when absent, revoked or another org's. */
export async function activeTokenLimits(
	orgId: string,
	tokenId: string,
): Promise<{ id: string; name: string; scopes: AgentScope[]; projectIds: string[] | null } | null> {
	const [row] = await getServiceDb()
		.select({
			id: cliServiceTokens.id,
			name: cliServiceTokens.name,
			scopes: cliServiceTokens.scopes,
			project_ids: cliServiceTokens.project_ids,
		})
		.from(cliServiceTokens)
		.where(and(eq(cliServiceTokens.id, tokenId), eq(cliServiceTokens.organization_id, orgId), isNull(cliServiceTokens.revoked_at)))
		.limit(1);
	return row ? { id: row.id, name: row.name, scopes: row.scopes, projectIds: row.project_ids } : null;
}

/**
 * Stores `environmentIds` as the auto-approve list of active token `tokenId` in `orgId`. The caller
 * has already checked the list with {@link autoApproveRefusal}. Returns false when the token is gone,
 * revoked, or another org's.
 */
export async function writeAutoApprove(orgId: string, tokenId: string, environmentIds: readonly string[]): Promise<boolean> {
	const rows = await getServiceDb()
		.update(cliServiceTokens)
		.set({ auto_approve_environment_ids: [...new Set(environmentIds)] })
		.where(and(eq(cliServiceTokens.id, tokenId), eq(cliServiceTokens.organization_id, orgId), isNull(cliServiceTokens.revoked_at)))
		.returning({ id: cliServiceTokens.id });
	return rows.length > 0;
}
