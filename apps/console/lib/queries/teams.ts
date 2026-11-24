// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";
import { and, count, eq, ilike, inArray, or, type SQL, sql } from "drizzle-orm";
import type { TeamMemberLite, TeamRow } from "@/app/server/actions/teams";
import { getServiceDb } from "@/lib/db";
import { likeTerm } from "@/lib/db/like";
import { team, teamMember, user } from "@/lib/db/schema";
import { type FacetOption, narrowTo, orderedOptions, searchTerm } from "./facets";
import {
	KEYSET_DEFAULT_LIMIT,
	type KeysetListPage,
	type KeysetPageRequest,
	keysetAfter,
	keysetFetchLimit,
	keysetListPage,
	keysetOrderBy,
	keysetPage,
	keysetSortKey,
} from "./keyset";

// The Settings › Teams list, filtered in SQL (the console filter standard's server half).
// Service path with an explicit `organization_id` filter — the service role bypasses RLS,
// so the org scope is enforced here, exactly as the unfiltered `getTeams()` does.
//
// Paged on the console's ONE contract (lib/query/README.md → "Paging"; LST-8 #7490): newest team
// first by `created_at` truncated to the millisecond, then the id, through the shared keyset codec.
// It used to read every team and let the browser page them 20 at a time.
//
// `TeamRow`/`TeamMemberLite` stay defined in the action module (every component already
// imports them from there); the import above is type-only, so it is erased and no runtime
// cycle exists between the two files.

/**
 * Team size buckets. Finite and known, so a typed union rather than free strings — and the
 * SQL below is the ONLY place the boundaries live, so a bucket cannot mean one thing in the
 * filter and another in its count.
 */
export const TEAM_SIZE_BUCKETS = ["empty", "small", "large"] as const;

export type TeamSizeBucket = (typeof TEAM_SIZE_BUCKETS)[number];

/** The bucket a member count falls in (the JS mirror of {@link bucketPredicate}). */
export function teamSizeBucket(memberCount: number): TeamSizeBucket {
	if (memberCount === 0) return "empty";
	return memberCount <= 5 ? "small" : "large";
}

/** The Teams list's normalized filter query (the `normalizeTeamsQuery()` output). */
export interface TeamsQuery {
	/** Case-insensitive contains-match over the team name. */
	search?: string;
	/** Restrict to these size buckets (OR semantics); empty/unknown = all. */
	sizes?: string[];
}

/** The size facet behind the Teams filter bar: all three buckets, over the org's UNFILTERED teams. */
export interface TeamsFacets {
	sizes: FacetOption[];
}

/** One page of the Teams list (`KeysetListPage`): rows, the next cursor, and first-page facets. */
export type TeamsPage = KeysetListPage<TeamRow, TeamsFacets>;

/** A team's keyset sort key — when it was created, truncated to the millisecond. */
const TEAM_LISTED_AT: SQL = keysetSortKey(team.createdAt);

/** The aggregate a size bucket is a predicate over. */
const MEMBER_COUNT = sql`count(${teamMember.userId})`;

/** The HAVING fragment selecting one size bucket. */
function bucketPredicate(bucket: TeamSizeBucket): SQL {
	switch (bucket) {
		case "empty":
			return sql`${MEMBER_COUNT} = 0`;
		case "small":
			return sql`${MEMBER_COUNT} between 1 and 5`;
		case "large":
			return sql`${MEMBER_COUNT} >= 6`;
	}
}

/**
 * One page of the org's teams for `query`, newest first — rows filtered in SQL, plus (on the first
 * page only) size-facet counts over the org's UNFILTERED teams: options must not disappear as you
 * select them, so the facet pass below is given the org predicate and nothing else. A later page
 * carries `facets: null`.
 */
export async function queryTeamsPage(
	orgId: string,
	query: TeamsQuery = {},
	request: KeysetPageRequest = { limit: KEYSET_DEFAULT_LIMIT },
): Promise<TeamsPage> {
	const db = getServiceDb();
	const search = searchTerm(query.search);
	const sizes = narrowTo(TEAM_SIZE_BUCKETS, query.sizes);
	const firstPage = request.cursor === undefined;

	const [fetched, facetRows] = await Promise.all([
		// ROWS: org scope + the query's predicates + the cursor, `limit + 1` of them. The size
		// bucket is a HAVING over the member count, so it narrows after the grouping.
		db
			.select({ id: team.id, name: team.name, createdAt: team.createdAt, memberCount: count(teamMember.userId) })
			.from(team)
			.leftJoin(teamMember, eq(teamMember.teamId, team.id))
			.where(
				and(
					eq(team.organizationId, orgId),
					search ? ilike(team.name, likeTerm(search)) : undefined,
					keysetAfter(TEAM_LISTED_AT, team.id, request.cursor),
				),
			)
			.groupBy(team.id, team.name, team.createdAt)
			.having(sizes ? or(...sizes.map(bucketPredicate)) : undefined)
			.orderBy(...keysetOrderBy(TEAM_LISTED_AT, team.id))
			.limit(keysetFetchLimit(request.limit)),
		// FACETS (first page only): the org predicate ONLY — one light aggregate pass over every
		// team in the org, bucketed below. Never sees `search`, `sizes` or the cursor; that is
		// the invariant.
		firstPage
			? db
					.select({ teamId: team.id, memberCount: count(teamMember.userId) })
					.from(team)
					.leftJoin(teamMember, eq(teamMember.teamId, team.id))
					.where(eq(team.organizationId, orgId))
					.groupBy(team.id)
			: [],
	]);
	const cut = keysetPage(fetched, request.limit, (t) => ({ at: t.createdAt, id: t.id }));

	// The avatar stacks, for this page's teams only (the members of teams nobody asked for are
	// not part of the answer).
	const memberRows = cut.rows.length
		? await db
				.select({
					teamId: teamMember.teamId,
					userId: user.id,
					name: user.name,
					email: user.email,
				})
				.from(teamMember)
				.innerJoin(user, eq(teamMember.userId, user.id))
				.where(
					inArray(
						teamMember.teamId,
						cut.rows.map((t) => t.id),
					),
				)
		: [];

	const byTeam = new Map<string, TeamMemberLite[]>();
	for (const r of memberRows) {
		const display = r.name?.trim() || r.email;
		const list = byTeam.get(r.teamId) ?? [];
		list.push({
			userId: r.userId,
			name: display,
			initials: display.slice(0, 2).toUpperCase(),
		});
		byTeam.set(r.teamId, list);
	}

	const rows: TeamRow[] = cut.rows.map((t) => ({
		id: t.id,
		name: t.name,
		memberCount: t.memberCount,
		members: byTeam.get(t.id) ?? [],
	}));
	const page = { rows, nextCursor: cut.nextCursor };
	if (!firstPage) return keysetListPage(page, null);

	const bucketCounts = new Map<string, number>();
	for (const r of facetRows) {
		const bucket = teamSizeBucket(r.memberCount);
		bucketCounts.set(bucket, (bucketCounts.get(bucket) ?? 0) + 1);
	}
	return keysetListPage(page, {
		facets: { sizes: orderedOptions(bucketCounts, TEAM_SIZE_BUCKETS) },
		universeEmpty: facetRows.length === 0,
	});
}
