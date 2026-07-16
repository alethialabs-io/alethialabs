"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import {
	and,
	asc,
	count,
	eq,
	exists,
	inArray,
	isNotNull,
	ne,
	or,
} from "drizzle-orm";
import { z } from "zod";
import { listRoles } from "@/app/server/actions/roles";
import { getTeams } from "@/app/server/actions/teams";
import { requireOwner } from "@/lib/auth/owner";
import { currentActor } from "@/lib/authz/guard";
import type { Actor } from "@/lib/authz/types";
import { BUILTIN_ROLE_IDS, type BuiltInRole } from "@/lib/authz/registry";
import { canOrgInvite } from "@/lib/billing/collaboration";
import { getServiceDb, withOwnerScope } from "@/lib/db";
import {
	type AgentArtifact,
	agentArtifacts,
	agentArtifactShares,
	grants,
	member,
	role,
	team,
	teamMember,
} from "@/lib/db/schema";

/** A share scope the popover offers and the actions accept. */
export type ShareScopeType = "org" | "team" | "role";
const scopeTypeSchema = z.enum(["org", "team", "role"]);
const idSchema = z.string().uuid();

const BUILTIN_ROLE_ORDER: BuiltInRole[] = [
	"owner",
	"admin",
	"operator",
	"viewer",
];

/** The actor's principals used to match share rows: the teams they're in and roles they hold. */
async function resolveActorPrincipals(
	actor: Actor,
): Promise<{ teamIds: string[]; roleIds: string[] }> {
	const db = getServiceDb();
	const teams = await db
		.select({ id: teamMember.teamId })
		.from(teamMember)
		.innerJoin(team, eq(team.id, teamMember.teamId))
		.where(
			and(
				eq(teamMember.userId, actor.userId),
				eq(team.organizationId, actor.orgId),
			),
		);
	const teamIds = teams.map((t) => t.id);

	// Roles are captured entirely in `grants` (member.role is mirrored there by
	// ensureMemberGrant) — the role_ids granted to me directly or via a team I'm in.
	const principalCond = teamIds.length
		? or(
				and(
					eq(grants.principal_type, "user"),
					eq(grants.principal_id, actor.userId),
				),
				and(
					eq(grants.principal_type, "team"),
					inArray(grants.principal_id, teamIds),
				),
			)
		: and(
				eq(grants.principal_type, "user"),
				eq(grants.principal_id, actor.userId),
			);
	const roleRows = await db
		.select({ role_id: grants.role_id })
		.from(grants)
		.where(
			and(eq(grants.org_id, actor.orgId), isNotNull(grants.role_id), principalCond),
		);
	const roleIds = [
		...new Set(roleRows.map((r) => r.role_id).filter((x): x is string => !!x)),
	];
	return { teamIds, roleIds };
}

/** True only for a real org (not personal scope) that can collaborate and has teammates. */
async function canShareArtifacts(actor: Actor): Promise<boolean> {
	if (actor.orgId === actor.userId) return false; // personal scope — no one to share with
	if (!(await canOrgInvite(actor.orgId))) return false;
	const [row] = await getServiceDb()
		.select({ n: count() })
		.from(member)
		.where(eq(member.organizationId, actor.orgId));
	return (row?.n ?? 0) > 1;
}

export interface ArtifactShareAccess {
	/** Whether the Share UI should render at all (paid org with >1 member). */
	canShare: boolean;
	teams: { id: string; name: string }[];
	roles: { id: string; name: string }[];
}

/** Bootstrap for the Share popover: whether sharing is available + the org's teams and roles. */
export async function getArtifactShareAccess(): Promise<ArtifactShareAccess> {
	const actor = await currentActor();
	if (!(await canShareArtifacts(actor))) {
		return { canShare: false, teams: [], roles: [] };
	}
	const teams = (await getTeams()).map((t) => ({ id: t.id, name: t.name }));
	const builtins = BUILTIN_ROLE_ORDER.map((r) => ({
		id: BUILTIN_ROLE_IDS[r],
		name: r.charAt(0).toUpperCase() + r.slice(1),
	}));
	// Custom roles are a bonus; a viewer without member-view permission just gets built-ins.
	let custom: { id: string; name: string }[] = [];
	try {
		custom = (await listRoles()).map((r) => ({ id: r.id, name: r.name }));
	} catch {
		custom = [];
	}
	return { canShare: true, teams, roles: [...builtins, ...custom] };
}

/** Load an artifact only if the caller OWNS it (owner-scoped RLS) — the share/unshare gate. */
async function requireOwnedArtifact(artifactId: string): Promise<AgentArtifact> {
	const owner = await requireOwner();
	const artifact = await withOwnerScope(owner, async (tx) => {
		const [row] = await tx
			.select()
			.from(agentArtifacts)
			.where(eq(agentArtifacts.id, artifactId))
			.limit(1);
		return row ?? null;
	});
	if (!artifact) throw new Error("Artifact not found");
	return artifact;
}

/** Validate that a team/role scope target belongs to the actor's org (reject foreign ids). */
async function assertScopeInOrg(
	actor: Actor,
	scopeType: ShareScopeType,
	scopeId: string,
): Promise<void> {
	const db = getServiceDb();
	if (scopeType === "team") {
		const [row] = await db
			.select({ id: team.id })
			.from(team)
			.where(and(eq(team.id, scopeId), eq(team.organizationId, actor.orgId)))
			.limit(1);
		if (!row) throw new Error("Unknown team");
		return;
	}
	// role: a built-in id, or a custom role in this org.
	if (Object.values(BUILTIN_ROLE_IDS).includes(scopeId)) return;
	const [row] = await db
		.select({ id: role.id })
		.from(role)
		.where(and(eq(role.id, scopeId), eq(role.organization_id, actor.orgId)))
		.limit(1);
	if (!row) throw new Error("Unknown role");
}

/** The existing share targets for an artifact (creator only). */
export async function listArtifactShares(
	artifactId: string,
): Promise<{ scopeType: ShareScopeType; scopeId: string | null }[]> {
	const id = idSchema.parse(artifactId);
	const actor = await currentActor();
	if (!(await canShareArtifacts(actor))) return [];
	await requireOwnedArtifact(id);
	const rows = await getServiceDb()
		.select({
			scope_type: agentArtifactShares.scope_type,
			scope_id: agentArtifactShares.scope_id,
		})
		.from(agentArtifactShares)
		.where(
			and(
				eq(agentArtifactShares.artifact_id, id),
				eq(agentArtifactShares.org_id, actor.orgId),
			),
		);
	return rows.map((r) => ({ scopeType: r.scope_type, scopeId: r.scope_id }));
}

/** Grant an artifact to the whole org, a team, or a role (creator only, target-in-org). */
export async function shareArtifact(
	artifactId: string,
	scopeType: ShareScopeType,
	scopeId?: string,
): Promise<void> {
	const id = idSchema.parse(artifactId);
	const type = scopeTypeSchema.parse(scopeType);
	const actor = await currentActor();
	if (!(await canShareArtifacts(actor))) throw new Error("Sharing unavailable");
	await requireOwnedArtifact(id);

	let normScopeId: string | null = null;
	if (type === "org") {
		normScopeId = null;
	} else {
		normScopeId = idSchema.parse(scopeId);
		await assertScopeInOrg(actor, type, normScopeId);
	}
	await getServiceDb()
		.insert(agentArtifactShares)
		.values({
			artifact_id: id,
			org_id: actor.orgId,
			scope_type: type,
			scope_id: normScopeId,
			created_by: actor.userId,
		})
		.onConflictDoNothing();
}

/** Revoke a previously-granted share target (creator only). */
export async function unshareArtifact(
	artifactId: string,
	scopeType: ShareScopeType,
	scopeId?: string,
): Promise<void> {
	const id = idSchema.parse(artifactId);
	const type = scopeTypeSchema.parse(scopeType);
	const actor = await currentActor();
	if (!(await canShareArtifacts(actor))) throw new Error("Sharing unavailable");
	await requireOwnedArtifact(id);
	// (artifact, scope_type) already pins the row for 'org' (its scope_id is NULL and there's
	// at most one org share); team/role also match on scope_id.
	const conds = [
		eq(agentArtifactShares.artifact_id, id),
		eq(agentArtifactShares.org_id, actor.orgId),
		eq(agentArtifactShares.scope_type, type),
	];
	if (type !== "org") {
		conds.push(eq(agentArtifactShares.scope_id, idSchema.parse(scopeId)));
	}
	await getServiceDb().delete(agentArtifactShares).where(and(...conds));
}

/** Artifacts OTHERS have shared into my org that reach me (org-wide / a team I'm in / a role I hold). */
export async function listSharedArtifacts(): Promise<AgentArtifact[]> {
	const actor = await currentActor();
	if (actor.orgId === actor.userId) return []; // personal scope — no org shares
	const { teamIds, roleIds } = await resolveActorPrincipals(actor);

	const scopeConds = [eq(agentArtifactShares.scope_type, "org")];
	if (teamIds.length) {
		const c = and(
			eq(agentArtifactShares.scope_type, "team"),
			inArray(agentArtifactShares.scope_id, teamIds),
		);
		if (c) scopeConds.push(c);
	}
	if (roleIds.length) {
		const c = and(
			eq(agentArtifactShares.scope_type, "role"),
			inArray(agentArtifactShares.scope_id, roleIds),
		);
		if (c) scopeConds.push(c);
	}

	const db = getServiceDb();
	return db
		.select()
		.from(agentArtifacts)
		.where(
			and(
				ne(agentArtifacts.user_id, actor.userId),
				exists(
					db
						.select({ one: agentArtifactShares.id })
						.from(agentArtifactShares)
						.where(
							and(
								eq(agentArtifactShares.artifact_id, agentArtifacts.id),
								eq(agentArtifactShares.org_id, actor.orgId),
								or(...scopeConds),
							),
						),
				),
			),
		)
		.orderBy(asc(agentArtifacts.name));
}
