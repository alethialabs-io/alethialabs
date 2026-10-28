// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";

import { planMeta } from "@repo/plan-catalog";
import { and, asc, eq, exists, inArray, isNotNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { getBillingSummary, getCollaborationAccess } from "@/app/server/actions/billing";
import type { GrantOptions } from "@/app/server/actions/grants";
import type { InviteContext, MemberRow } from "@/app/server/actions/members";
import type { CustomRole, RoleRow, RolesBootstrap } from "@/app/server/actions/roles";
import { getPdp } from "@/lib/authz";
import { getEntitlements } from "@/lib/authz/entitlements";
import { authorize, authorizeQuiet, currentActor } from "@/lib/authz/guard";
import { toDisplayRole } from "@/lib/authz/org-access-control";
import {
	BUILT_IN_ROLE_DESCRIPTIONS,
	BUILT_IN_ROLES,
	BUILTIN_ROLE_IDS,
	type BuiltInRole,
	PERMISSIONS,
} from "@/lib/authz/registry";
import { isStripeConfigured } from "@/lib/billing/config";
import { isBillingActive } from "@/lib/billing/plan";
import { getOrgBilling } from "@/lib/billing/queries";
import { getServiceDb } from "@/lib/db";
import { likeTerm } from "@/lib/db/like";
import {
	cloudIdentities,
	grants,
	invitation,
	member,
	projects,
	role,
	rolePermission,
	runners,
	session,
	team,
	teamMember,
	user,
} from "@/lib/db/schema";
import type { BillingPlan } from "@/lib/db/schema/enums";
import { INVITE_ROLES } from "@/lib/members/roles";
import { type AccessGrantsPage, queryAccessGrantsPage } from "@/lib/queries/access-grants";
import { type MembersPage, queryMembersPage } from "@/lib/queries/members";
import { queryTeamsPage, type TeamsPage } from "@/lib/queries/teams";
import { query } from "@/lib/rpc/base";
import { typedKeys } from "@/lib/typed-object";

// THE PEOPLE & ACCESS READS (ADR 0005 D1, #6129): members, teams, roles and access grants. Every
// body below was MOVED here from its `"use server"` module (members.ts, teams.ts, roles.ts,
// grants.ts) — not wrapped — so the pages read them over GET and the RSC prefetch calls the same
// function in-process. The authorization of each read is the one it had as an action, unchanged:
//
//   · the member and team lists answer any member of the org (they were `currentActor()` reads);
//   · the role catalog, the custom roles and the grants answer `member:view` — `authorizeQuiet` for
//     the roles (no activity entry), `authorize` for the grants (a denial is recorded), as before.
//
// TENANCY. Every read resolves its actor from the request ADDRESS (the `query` base binds the actor
// the route handler or the server caller resolved), and every SQL predicate is on that actor's org.
// No input names an org, and no id in an input reaches a query un-scoped: the one id a caller passes
// is `members.grants`' optional `projectId` (the project-scoped Access surface), which narrows the
// org's own grants and never widens them — the query keeps `org_id = actor.orgId`. Every other input
// value is a filter (team names, role names), matched inside the actor's org.
// `tests/integration/rpc-tenancy.shared.ts` proves the address beats the session for every
// procedure here, and that a non-member of the addressed org is refused.

/** A filter list as the console's filter standard sends it: short strings, bounded. */
const filterValues = z.array(z.string().min(1).max(200)).max(200).optional();

/** The members page's filter query (`normalizeMembersQuery()`), validated. */
const membersPageInput = z.object({
	search: z.string().max(200).optional(),
	statuses: filterValues,
	roles: filterValues,
	teams: filterValues,
});

/** The teams page's filter query (`normalizeTeamsQuery()`), validated. */
const teamsPageInput = z.object({
	search: z.string().max(200).optional(),
	sizes: filterValues,
});

/** The roles rail's server-side search. Absent or empty is the unsearched universe. */
const rolesInput = z.object({ search: z.string().max(200).optional() });

/** The access page's filter query (`normalizeAccessQuery()`), validated. */
const grantsPageInput = z.object({
	projectId: z.string().uuid().optional(),
	search: z.string().max(200).optional(),
	scopes: filterValues,
	roles: filterValues,
	effects: filterValues,
});

// ── Members ─────────────────────────────────────────────────────────────────────────────────

/**
 * Members of the addressed organization (member ⋈ user), each with their team names. In the
 * personal scope there are no `member` rows, so the single owner (the caller) is synthesized,
 * making the page truthful rather than locked. Any member reads it.
 *
 * The shared universe read: the activity log's and the jobs list's name resolution, the manage-team
 * dialog's roster and the grant builder's principals all read it (`members.list`).
 */
export async function listOrgMembers(): Promise<MemberRow[]> {
	const actor = await currentActor();
	const db = getServiceDb();

	const rows = await db
		.select({
			id: member.id,
			userId: user.id,
			name: user.name,
			username: user.username,
			email: user.email,
			image: user.image,
			role: member.role,
			status: member.status,
			joinedAt: member.createdAt,
		})
		.from(member)
		.innerJoin(user, eq(member.userId, user.id))
		.where(eq(member.organizationId, actor.orgId))
		// ORDERED, because the caller renders it as a LIST and re-reads it: without an order the
		// same query may answer in a different order on the same data, which re-keys the table and
		// closes a row's open menu (#4852). `id` breaks the tie so the order is total.
		.orderBy(asc(member.createdAt), asc(member.id));

	if (rows.length === 0) {
		// Personal workspace: you are the sole owner.
		const [u] = await db
			.select({
				id: user.id,
				name: user.name,
				username: user.username,
				email: user.email,
				image: user.image,
				createdAt: user.createdAt,
			})
			.from(user)
			.where(eq(user.id, actor.userId))
			.limit(1);
		if (!u) return [];
		return [
			{
				id: u.id,
				userId: u.id,
				name: u.name,
				username: u.username,
				email: u.email,
				image: u.image,
				role: "owner",
				status: "active",
				joinedAt: u.createdAt.toISOString(),
				teams: [],
				lastActiveAt: new Date().toISOString(),
			},
		];
	}

	// Team names per member (only this org's teams).
	const userIds = rows.map((r) => r.userId);
	const teamRows = await db
		.select({ userId: teamMember.userId, name: team.name })
		.from(teamMember)
		.innerJoin(team, eq(teamMember.teamId, team.id))
		.where(and(eq(team.organizationId, actor.orgId), inArray(teamMember.userId, userIds)));
	const teamsByUser = new Map<string, string[]>();
	for (const t of teamRows) {
		const arr = teamsByUser.get(t.userId) ?? [];
		arr.push(t.name);
		teamsByUser.set(t.userId, arr);
	}

	// Last-active = the most recent session per user.
	const lastRows = await db
		.select({ userId: session.userId, last: sql<string>`max(${session.updatedAt})` })
		.from(session)
		.where(inArray(session.userId, userIds))
		.groupBy(session.userId);
	const lastByUser = new Map<string, string>();
	for (const r of lastRows) {
		if (r.last) lastByUser.set(r.userId, new Date(r.last).toISOString());
	}

	return rows.map((r) => ({
		...r,
		// The role the row GRANTS, not the string better-auth stored: its built-in `member` is our
		// viewer, and the role <select> only offers our four.
		role: toDisplayRole(r.role),
		joinedAt: r.joinedAt.toISOString(),
		teams: teamsByUser.get(r.userId) ?? [],
		lastActiveAt: lastByUser.get(r.userId) ?? null,
	}));
}

/**
 * The Members PAGE read: member rows AND pending invitations filtered server-side, plus the
 * status/role/team facets over the org's unfiltered universe (the console filter standard). Any
 * member reads it; the personal-scope fallback is synthesized from the caller alone.
 */
export async function readMembersPage(input: z.infer<typeof membersPageInput>): Promise<MembersPage> {
	const actor = await currentActor();
	return queryMembersPage(actor.orgId, actor.userId, input);
}

/**
 * What the Members page needs to decide its controls, resolved on the server so the first paint
 * carries the answer (no client store to wait for, F017):
 *
 * - `canManage` — the org's `organizations` entitlement (the management columns);
 * - `canInvite` — the SAME predicate `beforeCreateInvitation` enforces (`canOrgInvite`), so the
 *   button is never offered where the invite would be refused;
 * - `plan` — the EFFECTIVE plan, derived exactly as the switcher's plan badge derives it
 *   (`workspace.context`: the billing row's plan while its status is live, else community). On a
 *   hosted deployment `canInvite` is `plan !== "community"` by construction, so an org the badge
 *   shows as Pro or Enterprise is never told to upgrade (F049/F057);
 * - `inviteBlockedReason` — why inviting is closed, for `DisabledReason`; null when it is open.
 */
export interface MembersGate {
	canManage: boolean;
	canInvite: boolean;
	plan: BillingPlan;
	inviteBlockedReason: string | null;
}

/** Resolves {@link MembersGate} for the addressed org. Any member reads it. */
export async function readMembersGate(): Promise<MembersGate> {
	const actor = await currentActor();
	const personal = actor.orgId === actor.userId;
	const [collaboration, billing] = await Promise.all([
		getCollaborationAccess(),
		personal ? Promise.resolve(null) : getOrgBilling(actor.orgId),
	]);
	const plan: BillingPlan =
		billing && isBillingActive(billing.status) ? billing.plan : "community";
	return {
		canManage: getEntitlements(actor).organizations,
		canInvite: collaboration.canInvite,
		plan,
		inviteBlockedReason: collaboration.canInvite
			? null
			: inviteBlockedReason({ personal, plan, hosted: isStripeConfigured() }),
	};
}

/**
 * The sentence `DisabledReason` shows on a closed Invite button. It names the plan the badge
 * shows, so it can never offer an upgrade to a plan the org already has.
 */
export function inviteBlockedReason(opts: {
	personal: boolean;
	plan: BillingPlan;
	hosted: boolean;
}): string {
	if (opts.personal) return "Your personal workspace has no members. Create an organization to invite teammates.";
	if (opts.plan === "community") {
		return `Inviting members is available on the ${planMeta("team").name} plan.`;
	}
	// A live paid plan that still cannot invite: the subscription state, not the tier, is the gate.
	return `Inviting is paused while this organization's ${planMeta(opts.plan).name} subscription is not active.`;
}

/**
 * Everything the invite dialog needs in one read: the collaboration gate, plan/seat figures, the
 * role choices, and the emails already taken (member or pending) for client-side dedupe. Any
 * member reads it; the invite itself goes through Better Auth, gated by `beforeCreateInvitation`.
 */
export async function readInviteContext(): Promise<InviteContext> {
	const actor = await currentActor();
	const db = getServiceDb();
	const personal = actor.orgId === actor.userId;

	const [access, billing, memberEmails, inviteEmails] = await Promise.all([
		getCollaborationAccess(),
		getBillingSummary(),
		personal
			? Promise.resolve([])
			: db
					.select({ email: user.email })
					.from(member)
					.innerJoin(user, eq(member.userId, user.id))
					.where(eq(member.organizationId, actor.orgId)),
		personal
			? Promise.resolve([])
			: db
					.select({ email: invitation.email })
					.from(invitation)
					.where(and(eq(invitation.organizationId, actor.orgId), eq(invitation.status, "pending"))),
	]);

	return {
		canInvite: access.canInvite,
		hosted: billing.hosted,
		plan: billing.plan,
		memberCount: billing.memberCount,
		unitAmount: billing.unitAmount,
		roles: [...INVITE_ROLES],
		existingEmails: memberEmails.map((r) => r.email.toLowerCase()),
		pendingEmails: inviteEmails.map((r) => r.email.toLowerCase()),
	};
}

// ── Teams ───────────────────────────────────────────────────────────────────────────────────

/**
 * The Teams PAGE read: rows filtered server-side, plus size-facet counts over the org's unfiltered
 * teams. Any member reads it; every predicate is on the addressed org.
 */
export async function readTeamsPage(input: z.infer<typeof teamsPageInput>): Promise<TeamsPage> {
	const actor = await currentActor();
	return queryTeamsPage(actor.orgId, input);
}

// ── Roles ───────────────────────────────────────────────────────────────────────────────────

const ALL_KEYS: string[] = PERMISSIONS.map((p) => p.key);
const ORDER: BuiltInRole[] = ["owner", "admin", "operator", "viewer"];

/** The permission keys a built-in role grants ("*" → every key). */
function builtinKeys(name: BuiltInRole): string[] {
	const grant = BUILT_IN_ROLES[name];
	return grant === "*" ? ALL_KEYS : grant;
}

/**
 * Distinct-USER grant counts per role in an org. Counts only `user` principals (team grants
 * contribute 0) and de-duplicates a principal holding the role both org-wide and scoped, so
 * "N members affected" is accurate. Roles with no grants are absent (→ 0).
 */
async function grantCountsByRole(orgId: string): Promise<Map<string, number>> {
	const rows = await getServiceDb()
		.select({
			roleId: grants.role_id,
			n: sql<number>`count(distinct case when ${grants.principal_type} = 'user' then ${grants.principal_id} end)`,
		})
		.from(grants)
		.where(and(eq(grants.org_id, orgId), isNotNull(grants.role_id)))
		.groupBy(grants.role_id);
	const map = new Map<string, number>();
	for (const r of rows) if (r.roleId) map.set(r.roleId, Number(r.n));
	return map;
}

/** Groups `role_permission` rows into a role id → permission keys map. */
async function permissionKeysByRole(roleIds: string[]): Promise<Map<string, string[]>> {
	const perms = await getServiceDb()
		.select({ roleId: rolePermission.role_id, key: rolePermission.permission_key })
		.from(rolePermission)
		.where(inArray(rolePermission.role_id, roleIds));
	const byRole = new Map<string, string[]>();
	for (const p of perms) {
		const list = byRole.get(p.roleId) ?? [];
		list.push(p.key);
		byRole.set(p.roleId, list);
	}
	return byRole;
}

/**
 * The addressed org's custom (non-built-in) roles with their permission keys. Reading the role
 * config requires `member:view` (roles are member-management config).
 */
export async function listCustomRoles(): Promise<CustomRole[]> {
	const actor = await authorizeQuiet("view", { type: "member" });
	const roles = await getServiceDb()
		.select({ id: role.id, name: role.name, description: role.description })
		.from(role)
		.where(and(eq(role.organization_id, actor.orgId), eq(role.is_builtin, false)));
	if (roles.length === 0) return [];
	const byRole = await permissionKeysByRole(roles.map((r) => r.id));
	return roles.map((r) => ({ ...r, permissionKeys: byRole.get(r.id) ?? [] }));
}

/**
 * Everything the Roles page needs beyond the searchable custom list: the built-in roles with
 * their grant counts, the permission catalog, the Enterprise entitlement and a non-throwing
 * manage-permission check. Requires `member:view` — a viewer without it gets FORBIDDEN, which the
 * page renders as its no-access state.
 */
export async function readRolesCatalog(): Promise<RolesBootstrap> {
	const actor = await authorizeQuiet("view", { type: "member" });
	const [counts, canManage] = await Promise.all([
		grantCountsByRole(actor.orgId),
		getPdp()
			.can(actor, "manage_members", { type: "member" })
			.then((d) => d.allowed),
	]);
	const builtin: RoleRow[] = ORDER.map((name) => ({
		id: BUILTIN_ROLE_IDS[name],
		name,
		description: BUILT_IN_ROLE_DESCRIPTIONS[name],
		builtin: true,
		permissionKeys: builtinKeys(name),
		grantCount: counts.get(BUILTIN_ROLE_IDS[name]) ?? 0,
	}));
	return {
		builtin,
		permissions: PERMISSIONS,
		customRoles: getEntitlements(actor).customRoles,
		canManage,
	};
}

/**
 * The addressed org's custom roles, filtered server-side by `search` over the role name,
 * description or any of its permission keys (LIKE-escaped), each with its permission keys and
 * distinct-user grant count. `member:view` gated.
 */
export async function listRoles(search?: string): Promise<RoleRow[]> {
	const actor = await authorizeQuiet("view", { type: "member" });
	const db = getServiceDb();
	const q = search?.trim();
	const like = q ? likeTerm(q) : null;

	const roles = await db
		.select({ id: role.id, name: role.name, description: role.description })
		.from(role)
		.where(
			and(
				eq(role.organization_id, actor.orgId),
				eq(role.is_builtin, false),
				like
					? or(
							sql`${role.name} ilike ${like}`,
							sql`${role.description} ilike ${like}`,
							exists(
								db
									.select({ one: sql`1` })
									.from(rolePermission)
									.where(
										and(
											eq(rolePermission.role_id, role.id),
											sql`${rolePermission.permission_key} ilike ${like}`,
										),
									),
							),
						)
					: undefined,
			),
		)
		.orderBy(asc(role.name));
	if (roles.length === 0) return [];

	const [byRole, counts] = await Promise.all([
		permissionKeysByRole(roles.map((r) => r.id)),
		grantCountsByRole(actor.orgId),
	]);
	return roles.map((r) => ({
		id: r.id,
		name: r.name,
		description: r.description,
		builtin: false,
		permissionKeys: byRole.get(r.id) ?? [],
		grantCount: counts.get(r.id) ?? 0,
	}));
}

// ── Access grants ───────────────────────────────────────────────────────────────────────────

/**
 * The Access PAGE read: grants filtered server-side, plus scope/role/effect facets over the
 * unfiltered grants of the same scope. `query.projectId` selects the universe (the project-scoped
 * Access surface), matched inside the addressed org. Enumerating grants requires `member:view`,
 * ENFORCED (a denial is recorded) — mirroring the CLI `GET /api/cli/grants` gate.
 */
export async function readGrantsPage(
	input: z.infer<typeof grantsPageInput>,
): Promise<AccessGrantsPage & { asOf: string }> {
	const actor = await authorize("view", { type: "member" });
	const page = await queryAccessGrantsPage(actor.orgId, input);
	// The instant of the read, so "Granted 3 hours ago" is computed against the same clock on the
	// server render and on the hydrating client (React #418) — the members page's `asOf` rule.
	return { ...page, asOf: new Date().toISOString() };
}

/**
 * Everything the "Grant access" builder needs: the org's members and teams as principals, the
 * built-in and custom roles, the permission catalog, and the org's projects, runners and cloud
 * identities as scopes. Requires `member:view`, enforced; every list is the addressed org's.
 */
export async function readGrantOptions(): Promise<GrantOptions> {
	const actor = await authorize("view", { type: "member" });
	const db = getServiceDb();
	const [members, teamRows, projectRows, runnerRows, idRows, custom] = await Promise.all([
		listOrgMembers(),
		db.select({ id: team.id, label: team.name }).from(team).where(eq(team.organizationId, actor.orgId)),
		db
			.select({ id: projects.id, label: projects.project_name })
			.from(projects)
			.where(eq(projects.org_id, actor.orgId)),
		db.select({ id: runners.id, label: runners.name }).from(runners).where(eq(runners.org_id, actor.orgId)),
		db
			.select({ id: cloudIdentities.id, label: cloudIdentities.name })
			.from(cloudIdentities)
			.where(eq(cloudIdentities.org_id, actor.orgId)),
		listCustomRoles(),
	]);

	const builtin = typedKeys(BUILTIN_ROLE_IDS).map((name) => ({
		id: BUILTIN_ROLE_IDS[name],
		name,
		builtin: true,
	}));

	return {
		principals: [
			...members.map((m) => ({ id: m.userId, label: m.name ?? m.email, type: "user" as const })),
			...teamRows.map((t) => ({ id: t.id, label: t.label, type: "team" as const })),
		],
		roles: [...builtin, ...custom.map((r) => ({ id: r.id, name: r.name, builtin: false }))],
		permissions: PERMISSIONS.map((p) => ({ key: p.key, resource: p.resource, action: p.action })),
		resources: { project: projectRows, runner: runnerRows, cloud_identity: idRows },
	};
}

/**
 * The people & access reads (ADR 0005 D1, #6129). Members and teams answer any member of the
 * addressed org; roles and grants answer `member:view`. A refusal is a typed FORBIDDEN, which the
 * pages render as their no-access state — never as an empty list.
 */
export const membersRouter = {
	page: query.input(membersPageInput).handler(({ input }) => readMembersPage(input)),
	list: query.handler(() => listOrgMembers()),
	gate: query.handler(() => readMembersGate()),
	inviteContext: query.handler(() => readInviteContext()),
	teams: query.input(teamsPageInput).handler(({ input }) => readTeamsPage(input)),
	roles: query.input(rolesInput).handler(({ input }) => listRoles(input.search)),
	roleCatalog: query.handler(() => readRolesCatalog()),
	grants: query.input(grantsPageInput).handler(({ input }) => readGrantsPage(input)),
	grantOptions: query.handler(() => readGrantOptions()),
};
