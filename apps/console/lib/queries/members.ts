// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";
import {
	and,
	eq,
	exists,
	ilike,
	inArray,
	isNull,
	ne,
	or,
	type SQL,
	sql,
} from "drizzle-orm";
import type { InvitationRow, MemberRow } from "@/app/server/actions/members";
import {
	storedRolesFor,
	toDisplayRole,
	toOrgRole,
} from "@/lib/authz/org-access-control";
import { getServiceDb } from "@/lib/db";
import { likeTerm } from "@/lib/db/like";
import {
	invitation,
	member,
	session,
	team,
	teamMember,
	user,
} from "@/lib/db/schema";
import {
	asOptions,
	type FacetOption,
	narrowTo,
	nonEmpty,
	orderedOptions,
	searchTerm,
	tally,
} from "./facets";
import {
	KEYSET_DEFAULT_LIMIT,
	type KeysetListPage,
	type KeysetPageRequest,
	keysetAfter,
	keysetFetchLimit,
	keysetListPage,
	keysetOrderBy,
	keysetPageInMemory,
	keysetSortKey,
} from "./keyset";

// The Settings › Members list, filtered in SQL (the console filter standard's server half).
// Service path with an explicit `organization_id` filter — the service role bypasses RLS,
// so the org scope is enforced here, exactly as the unfiltered `getMembers()` does.
//
// The page's table is a UNION of two record kinds: `member` rows and PENDING `invitation`
// rows, which the client renders as one list with a `status` of active/suspended/pending.
// So the status facet spans both tables and one read returns both — filtering them in two
// independent round-trips would let a "pending"-only selection still pay for the member query.
//
// PAGING (lib/query/README.md → "Paging"; LST-8 #7490). The two kinds share ONE keyset order —
// when the row came to be (a member's `created_at`, an invitation's `created_at`) truncated to the
// millisecond, newest first, then the id — so they page as one list through the shared codec. Each
// kind is read with its own strictly-after-the-cursor predicate and `limit + 1` rows, and the two
// are merged in that order and cut to `limit` (`keysetPageInMemory`). That is a correct k-way merge,
// not an approximation: any row among the next `limit + 1` of the union is among the next `limit + 1`
// of its own table, so nothing the cut keeps can be missing from what was read. Both ids are uuids
// and random, so the id tiebreak is total across the two tables as well as within each. It used to
// read every member and every invitation and let the browser page them 20 at a time.
//
// `MemberRow`/`InvitationRow` stay defined in the action module (components import them
// from there); the import above is type-only, so it is erased and no runtime cycle exists.

/**
 * One pending invitation as the members page reads it: the action module's row plus when its link
 * stops working (#6827, from CON-L10). Better Auth keeps an expired invitation `pending`, so
 * "expired" is a comparison the table makes against the page's `asOf`, not a status.
 */
export interface MembersPageInvitation extends InvitationRow {
	/** ISO instant the invitation's link expires (a resend moves it forward). */
	expiresAt: string;
}

/** The three states a row of the members table can be in — the status facet's values. */
export const MEMBER_ROW_STATUSES = ["active", "pending", "suspended"] as const;

export type MemberRowStatus = (typeof MEMBER_ROW_STATUSES)[number];

/** The role an invitation with no explicit role grants on accept (the action's mapping). */
const DEFAULT_INVITE_ROLE = "viewer";

/**
 * The stored `role` spellings a role-facet selection matches — every requested role plus the
 * aliases that resolve to it (better-auth's own `member` IS a viewer, `toPdpRole`). Rows are
 * DISPLAYED under the resolved name, so selecting "viewer" must also select the rows stored as
 * `member`, or the facet would offer a count it cannot then produce.
 */
function storedRoleFilter(roles: string[]): string[] {
	const own = new Set<string>();
	for (const role of roles) {
		const narrowed = toOrgRole(role);
		if (!narrowed) {
			// Not one of ours (a custom role, or a stale value in the URL) — match it literally.
			own.add(role);
			continue;
		}
		for (const stored of storedRolesFor(narrowed)) own.add(stored);
	}
	return [...own];
}

/** The Members list's normalized filter query (the `normalizeMembersQuery()` output). */
export interface MembersQuery {
	/** Contains-match over what the row DISPLAYS: name + email, or an invite's email +
	 * "invited by <inviter>". */
	search?: string;
	/** Restrict to these row statuses (OR semantics); empty/unknown = all. */
	statuses?: string[];
	/** Restrict to these org role names; empty = all. */
	roles?: string[];
	/** Restrict to members of these teams, BY NAME (a member matches if any team does). */
	teams?: string[];
}

/** The status/role/team facets behind the Members filter bar, over the org's UNFILTERED universe. */
export interface MembersFacets {
	/** All three statuses, always. */
	statuses: FacetOption[];
	/** Roles present in the org (members + pending invitations). */
	roles: FacetOption[];
	/** Team names; a member in several teams counts once per team. */
	teams: FacetOption[];
}

/**
 * One member row of the list. `isYou` and `asOf` are decided by the SERVER and carried in the
 * payload, because the payload is what the route prefetches and dehydrates: the server render and
 * the hydrating client then read the same two values and produce the same markup (#5377, React
 * #418). The session hook gives no such guarantee — better-auth's `useStore` passes the client's
 * live `get` as `getServerSnapshot`, so a "You" badge could appear that the server HTML never had.
 */
export interface MembersListMember extends MemberRow {
	kind: "member";
	/** This is the viewer's own row (the table marks it "You" and offers it no bulk action). */
	isYou: boolean;
	/** When the page holding this row was read (ISO) — what "Last active … ago" is measured from. */
	asOf: string;
}

/** One pending invitation of the list; `asOf` as on {@link MembersListMember}. */
export interface MembersListInvite extends MembersPageInvitation {
	kind: "invite";
	/** When the page holding this row was read (ISO) — what "invited … ago" and the expiry read against. */
	asOf: string;
}

/** A row of the Members list: a member or a pending invitation, in the one keyset order. */
export type MembersListRow = MembersListMember | MembersListInvite;

/** One page of the Members list (`KeysetListPage`): rows, the next cursor, and first-page facets. */
export type MembersPage = KeysetListPage<MembersListRow, MembersFacets>;

/** A member's keyset sort key — when they joined, truncated to the millisecond. */
const MEMBER_LISTED_AT: SQL = keysetSortKey(member.createdAt);

/** An invitation's keyset sort key — when it was sent, truncated to the millisecond. */
const INVITATION_LISTED_AT: SQL = keysetSortKey(invitation.createdAt);

/**
 * The status bucket a `member.status` falls in — the SQL mirror of the client's
 * `status === "suspended" ? "suspended" : "active"`. Anything that is not the explicit
 * suspended flag reads as active, in the predicate AND in the count.
 */
function memberStatusBucket(status: string): MemberRowStatus {
	return status === "suspended" ? "suspended" : "active";
}

/** The predicate selecting the member-row statuses in `statuses` (undefined = no filter). */
function memberStatusPredicate(statuses: MemberRowStatus[]): SQL | undefined {
	const wantsActive = statuses.includes("active");
	const wantsSuspended = statuses.includes("suspended");
	if (wantsActive && wantsSuspended) return undefined;
	if (wantsSuspended) return eq(member.status, "suspended");
	return ne(member.status, "suspended");
}

/**
 * One page of the org's members + pending invitations for `query`, newest first — rows filtered in
 * SQL, plus (on the first page only) facet counts over the org's UNFILTERED universe: the facet
 * passes below are given the org predicate and nothing else, so no option can vanish as you select
 * it. A later page carries `facets: null`; it walks the same universe and would count the same.
 *
 * `viewerUserId` is the caller: it marks the "You" row, and drives the personal-workspace fallback
 * — an org with no `member` rows IS the caller's personal org, and the first page must show the
 * sole owner (truthful) rather than an empty table (locked). That single row is synthesized, not
 * fetched, so the query is applied to it in memory — one row, not a narrowed universe.
 */
export async function queryMembersPage(
	orgId: string,
	viewerUserId: string,
	query: MembersQuery = {},
	request: KeysetPageRequest = { limit: KEYSET_DEFAULT_LIMIT },
): Promise<MembersPage> {
	const db = getServiceDb();
	// One instant for the whole read: every row's `asOf`, and the personal owner's "active now".
	const readAt = new Date();
	const asOf = readAt.toISOString();
	const firstPage = request.cursor === undefined;
	const fetchLimit = keysetFetchLimit(request.limit);
	const search = searchTerm(query.search);
	const like = search ? likeTerm(search) : undefined;
	const statuses = narrowTo(MEMBER_ROW_STATUSES, query.statuses);
	const roles = nonEmpty(query.roles);
	const teams = nonEmpty(query.teams);

	// A pending invitation has no teams and no session, so a team filter excludes every
	// invitation by construction — the same answer the client predicate gives.
	const wantsInvitations =
		(!statuses || statuses.includes("pending")) && !teams;
	const wantsMembers =
		!statuses || statuses.some((s) => s === "active" || s === "suspended");

	const memberConditions = [
		eq(member.organizationId, orgId),
		statuses ? memberStatusPredicate(statuses) : undefined,
		roles ? inArray(member.role, storedRoleFilter(roles)) : undefined,
		like
			? or(ilike(user.name, like), ilike(user.username, like), ilike(user.email, like))
			: undefined,
		teams
			? exists(
					db
						.select({ one: sql`1` })
						.from(teamMember)
						.innerJoin(team, eq(teamMember.teamId, team.id))
						.where(
							and(
								eq(teamMember.userId, member.userId),
								eq(team.organizationId, orgId),
								inArray(team.name, teams),
							),
						),
				)
			: undefined,
		keysetAfter(MEMBER_LISTED_AT, member.id, request.cursor),
	];

	const inviteConditions = [
		eq(invitation.organizationId, orgId),
		eq(invitation.status, "pending"),
		roles
			? or(
					inArray(invitation.role, storedRoleFilter(roles)),
					// A null role IS `viewer` once accepted, so the viewer facet must select it.
					roles.includes(DEFAULT_INVITE_ROLE) ? isNull(invitation.role) : undefined,
				)
			: undefined,
		like ? or(ilike(invitation.email, like), ilike(user.name, like)) : undefined,
		keysetAfter(INVITATION_LISTED_AT, invitation.id, request.cursor),
	];

	const [memberRows, inviteRows, facetMembers, facetInvites, facetTeams] =
		await Promise.all([
			// ROWS (members): org scope + the query's predicates + the cursor, `limit + 1` of them.
			wantsMembers
				? db
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
						.where(and(...memberConditions.filter((c) => c !== undefined)))
						.orderBy(...keysetOrderBy(MEMBER_LISTED_AT, member.id))
						.limit(fetchLimit)
				: [],
			// ROWS (pending invitations): the same, in the same order. Personal scope (orgId ===
			// the user's own id) has no invitations at all.
			wantsInvitations && orgId !== viewerUserId
				? db
						.select({
							id: invitation.id,
							email: invitation.email,
							role: invitation.role,
							inviterName: user.name,
							inviterEmail: user.email,
							createdAt: invitation.createdAt,
							expiresAt: invitation.expiresAt,
						})
						.from(invitation)
						.leftJoin(user, eq(invitation.inviterId, user.id))
						.where(and(...inviteConditions.filter((c) => c !== undefined)))
						.orderBy(...keysetOrderBy(INVITATION_LISTED_AT, invitation.id))
						.limit(fetchLimit)
				: [],
			// FACETS (first page only): the org predicate ONLY. Three light passes over the whole
			// universe — none of them sees `search`, `statuses`, `roles`, `teams` or the cursor.
			// That is the invariant.
			firstPage
				? db
						.select({ role: member.role, status: member.status })
						.from(member)
						.where(eq(member.organizationId, orgId))
				: [],
			firstPage
				? db
						.select({ role: invitation.role })
						.from(invitation)
						.where(
							and(
								eq(invitation.organizationId, orgId),
								eq(invitation.status, "pending"),
							),
						)
				: [],
			// Team memberships of the org's MEMBERS (the same population the rows come from),
			// so a facet count and a row count can never disagree about who is in a team.
			firstPage
				? db
						.select({ name: team.name })
						.from(teamMember)
						.innerJoin(team, eq(teamMember.teamId, team.id))
						.innerJoin(
							member,
							and(
								eq(member.userId, teamMember.userId),
								eq(member.organizationId, orgId),
							),
						)
						.where(eq(team.organizationId, orgId))
				: [],
		]);

	// The merge: both kinds in the one keyset order, cut to `limit`, with the exact next cursor.
	type Fetched =
		| { kind: "member"; id: string; at: Date; row: (typeof memberRows)[number] }
		| { kind: "invite"; id: string; at: Date; row: (typeof inviteRows)[number] };
	const fetched: Fetched[] = [
		...memberRows.map((row): Fetched => ({ kind: "member", id: row.id, at: row.joinedAt, row })),
		...inviteRows.map((row): Fetched => ({ kind: "invite", id: row.id, at: row.createdAt, row })),
	];
	const cut = keysetPageInMemory(fetched, request, (f) => ({ at: f.at, id: f.id }));

	// Personal workspace: no member rows anywhere in the org → you are the sole owner. Decided on
	// the first page, which is the only page a one-row list has.
	const personal = firstPage && facetMembers.length === 0;
	const syntheticOwner = personal
		? await synthesizeOwner(viewerUserId, readAt)
		: null;

	// Teams and last-active for the members ON THIS PAGE only — never the whole org.
	const userIds = cut.rows.flatMap((f) => (f.kind === "member" ? [f.row.userId] : []));
	const [teamRows, lastRows] = await Promise.all([
		userIds.length
			? db
					.select({ userId: teamMember.userId, name: team.name })
					.from(teamMember)
					.innerJoin(team, eq(teamMember.teamId, team.id))
					.where(
						and(
							eq(team.organizationId, orgId),
							inArray(teamMember.userId, userIds),
						),
					)
			: [],
		userIds.length
			? db
					.select({
						userId: session.userId,
						last: sql<string>`max(${session.updatedAt})`,
					})
					.from(session)
					.where(inArray(session.userId, userIds))
					.groupBy(session.userId)
			: [],
	]);

	const teamsByUser = new Map<string, string[]>();
	for (const t of teamRows) {
		const arr = teamsByUser.get(t.userId) ?? [];
		arr.push(t.name);
		teamsByUser.set(t.userId, arr);
	}
	const lastByUser = new Map<string, string>();
	for (const r of lastRows) {
		if (r.last) lastByUser.set(r.userId, new Date(r.last).toISOString());
	}

	const rows: MembersListRow[] = syntheticOwner
		? matchesSyntheticOwner(syntheticOwner, query, statuses)
			? [{ ...syntheticOwner, kind: "member", isYou: syntheticOwner.userId === viewerUserId, asOf }]
			: []
		: cut.rows.map((f): MembersListRow =>
				f.kind === "member"
					? {
							...f.row,
							kind: "member",
							// The role the row GRANTS, not the string better-auth happened to store: the
							// table's role <select> offers our four, and a raw `member` renders as no option.
							role: toDisplayRole(f.row.role),
							joinedAt: f.row.joinedAt.toISOString(),
							teams: teamsByUser.get(f.row.userId) ?? [],
							lastActiveAt: lastByUser.get(f.row.userId) ?? null,
							isYou: f.row.userId === viewerUserId,
							asOf,
						}
					: {
							kind: "invite",
							id: f.row.id,
							email: f.row.email,
							role: toDisplayRole(f.row.role ?? DEFAULT_INVITE_ROLE),
							inviterName: f.row.inviterName ?? f.row.inviterEmail ?? "—",
							createdAt: f.row.createdAt.toISOString(),
							expiresAt: f.row.expiresAt.toISOString(),
							asOf,
						},
			);
	const page = { rows, nextCursor: syntheticOwner ? null : cut.nextCursor };
	if (!firstPage) return keysetListPage(page, null);

	// The facet universe: every member row (or the synthetic owner) + every pending invite.
	const universeMembers = syntheticOwner
		? [{ role: syntheticOwner.role, status: syntheticOwner.status }]
		: facetMembers;
	const statusCounts = new Map<string, number>();
	for (const m of universeMembers) {
		const bucket = memberStatusBucket(m.status);
		statusCounts.set(bucket, (statusCounts.get(bucket) ?? 0) + 1);
	}
	statusCounts.set("pending", facetInvites.length);

	// Faceted under the SAME name the rows display, or an org with one better-auth `member`
	// would offer two buckets — `viewer` and `member` — that mean one role.
	const roleCounts = tally(
		[
			...universeMembers.map((m) => toDisplayRole(m.role)),
			...facetInvites.map((i) => toDisplayRole(i.role ?? DEFAULT_INVITE_ROLE)),
		],
		(role) => role,
	);
	const teamCounts = tally(facetTeams, (t) => t.name);

	return keysetListPage(page, {
		facets: {
			statuses: orderedOptions(statusCounts, MEMBER_ROW_STATUSES),
			roles: asOptions(roleCounts),
			teams: asOptions(teamCounts, (name) => name),
		},
		universeEmpty: universeMembers.length + facetInvites.length === 0,
	});
}

/**
 * The sole-owner row a personal workspace shows in place of `member` rows. The viewer IS this
 * owner and is reading the page, so they are active as of the read (`now`).
 */
async function synthesizeOwner(userId: string, now: Date): Promise<MemberRow | null> {
	const [u] = await getServiceDb()
		.select({
			id: user.id,
			name: user.name,
			username: user.username,
			email: user.email,
			image: user.image,
			createdAt: user.createdAt,
		})
		.from(user)
		.where(eq(user.id, userId))
		.limit(1);
	if (!u) return null;
	return {
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
		lastActiveAt: now.toISOString(),
	};
}

/** Applies the query to the ONE synthesized row (it has no DB row to filter in SQL). */
function matchesSyntheticOwner(
	owner: MemberRow,
	query: MembersQuery,
	statuses: MemberRowStatus[] | undefined,
): boolean {
	if (statuses && !statuses.includes("active")) return false;
	if (query.roles?.length && !query.roles.includes(owner.role)) return false;
	if (query.teams?.length) return false; // the personal owner is in no team
	const search = searchTerm(query.search)?.toLowerCase();
	if (
		search &&
		!`${owner.name ?? ""} ${owner.username ?? ""} ${owner.email}`
			.toLowerCase()
			.includes(search)
	) {
		return false;
	}
	return true;
}
