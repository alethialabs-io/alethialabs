// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";
import { and, asc, count, eq, ilike, inArray, or, type SQL, sql } from "drizzle-orm";
import type { TeamMemberLite, TeamRow } from "@/app/server/actions/teams";
import { getServiceDb } from "@/lib/db";
import { likeTerm } from "@/lib/db/like";
import { team, teamMember, user } from "@/lib/db/schema";
import { type FacetOption, narrowTo, orderedOptions, searchTerm } from "./facets";

// The Settings › Teams list, filtered in SQL (the console filter standard's server half).
// Service path with an explicit `organization_id` filter — the service role bypasses RLS,
// so the org scope is enforced here, exactly as the unfiltered `getTeams()` does.
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

/** Rows + the facet options behind the Teams filter bar. */
export interface TeamsPage {
	/** Teams matching the query, by name. */
	rows: TeamRow[];
	/** Teams matching the query. */
	resultCount: number;
	/** Every team in the org — the count pill's denominator. */
	total: number;
	facets: {
		/** All three buckets, always, counted over the org's UNFILTERED teams. */
		sizes: FacetOption[];
	};
}

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
 * The org's teams for `query` — rows filtered in SQL, plus size-facet counts over the
 * org's UNFILTERED teams (options must not disappear as you select them, so the facet
 * pass below is given the org predicate and nothing else).
 */
export async function queryTeamsPage(
	orgId: string,
	query: TeamsQuery = {},
): Promise<TeamsPage> {
	const db = getServiceDb();
	const search = searchTerm(query.search);
	const sizes = narrowTo(TEAM_SIZE_BUCKETS, query.sizes);

	const [matched, facetRows] = await Promise.all([
		// ROWS: org scope + the query's predicates.
		db
			.select({ id: team.id, name: team.name, memberCount: count(teamMember.userId) })
			.from(team)
			.leftJoin(teamMember, eq(teamMember.teamId, team.id))
			.where(
				and(
					eq(team.organizationId, orgId),
					search ? ilike(team.name, likeTerm(search)) : undefined,
				),
			)
			.groupBy(team.id, team.name)
			.having(sizes ? or(...sizes.map(bucketPredicate)) : undefined)
			.orderBy(asc(team.name)),
		// FACETS: the org predicate ONLY — one light aggregate pass over every team in the
		// org, bucketed below. Never sees `search` or `sizes`; that is the invariant.
		db
			.select({ teamId: team.id, memberCount: count(teamMember.userId) })
			.from(team)
			.leftJoin(teamMember, eq(teamMember.teamId, team.id))
			.where(eq(team.organizationId, orgId))
			.groupBy(team.id),
	]);

	// The avatar stacks, for the matched teams only (the members of teams nobody asked
	// for are not part of the answer).
	const memberRows = matched.length
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
						matched.map((t) => t.id),
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

	const bucketCounts = new Map<string, number>();
	for (const r of facetRows) {
		const bucket = teamSizeBucket(r.memberCount);
		bucketCounts.set(bucket, (bucketCounts.get(bucket) ?? 0) + 1);
	}

	const rows: TeamRow[] = matched.map((t) => ({
		id: t.id,
		name: t.name,
		memberCount: t.memberCount,
		members: byTeam.get(t.id) ?? [],
	}));

	return {
		rows,
		resultCount: rows.length,
		total: facetRows.length,
		facets: { sizes: orderedOptions(bucketCounts, TEAM_SIZE_BUCKETS) },
	};
}
