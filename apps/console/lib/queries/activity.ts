// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";
import {
	and,
	count,
	desc,
	eq,
	gte,
	ilike,
	inArray,
	lt,
	lte,
	or,
	type SQL,
} from "drizzle-orm";
import type {
	ActivityPage,
	ActivityQuery,
	ActivityRow,
} from "@/app/server/actions/activity";
import { getServiceDb } from "@/lib/db";
import { likeTerm } from "@/lib/db/like";
import { authzActivityLog, projects, user } from "@/lib/db/schema";
import { asOptions, type FacetOption, orderedOptions, searchTerm } from "./facets";

// Settings › Activity, filtered in SQL (the console filter standard's server half). Service path
// with an explicit `org_id` predicate: the service role bypasses RLS, so the org scope is
// enforced here.
//
// Two kinds of read, and the difference between them is the standard:
//
//   * the ROWS pass takes every filter the caller sent — window, actors, event types, decision,
//     projects, search — plus the id cursor, and returns one page of rows;
//   * the FACET passes take the SCOPE predicates and nothing else: the org, and — on a project's
//     own Activity page — that project (`query.projectId`). They count the User, Project and
//     Events options over the UNFILTERED universe, so an option cannot vanish, or its count
//     move, as you select it.
//
// The time window is a FILTER, not scope, and so the facet passes do not see it: it is a control
// in the same bar, and `tests/lib/queries/filter-standard-facets.test.ts` names "a date bound" as
// the narrowing it exists to catch. A count therefore reads "events by this person in the log",
// not "in the window on screen".
//
// The log is append-only and can be large, so the facet passes are GROUP BY aggregates — one row
// per actor / project / (type, decision), never a row per event — and they run only for the
// FIRST page. "Load more" walks the same universe, so its counts would be identical; paying for
// them again per page would buy nothing.

/** The Activity bar's facet options, counted over the scope's unfiltered log. */
export interface ActivityFacets {
	/** One option per actor with at least one event; `label` is their name or email, when known. */
	actors: FacetOption[];
	/** The org's projects that are the resource of at least one event. Empty on a project's
	 *  own feed, which hides the Project facet. */
	projects: FacetOption[];
	/** One option per recorded `resource_type` (the Events sheet's `type:` tokens). */
	resourceTypes: FacetOption[];
	/** `allow` and `deny`, always both (the Events sheet's `result:` tokens). */
	decisions: FacetOption[];
}

/** The two decision values, in the order the Events sheet lists them. */
const DECISIONS = ["allow", "deny"] as const;

/** The "select" shape shared by the viewer + export, joined to the acting user. */
export function activitySelect() {
	return {
		id: authzActivityLog.id,
		actorId: authzActivityLog.actor_id,
		actorName: user.name,
		actorEmail: user.email,
		actorImage: user.image,
		actorUsername: user.username,
		action: authzActivityLog.action,
		resourceType: authzActivityLog.resource_type,
		resourceId: authzActivityLog.resource_id,
		decision: authzActivityLog.decision,
		reason: authzActivityLog.reason,
		ts: authzActivityLog.ts,
	};
}

/** The scope predicates — the org, and the pinned project when there is one. Nothing else. */
function scopeOf(orgId: string, projectId: string | undefined): SQL[] {
	const scope = [eq(authzActivityLog.org_id, orgId)];
	if (projectId) scope.push(eq(authzActivityLog.resource_id, projectId));
	return scope;
}

/** A `Map` from grouped `{ value, count }` rows, dropping rows with no value. */
function countsOf(
	rows: { value: string | null; count: number }[],
): Map<string, number> {
	const counts = new Map<string, number>();
	for (const r of rows) {
		if (r.value) counts.set(r.value, (counts.get(r.value) ?? 0) + r.count);
	}
	return counts;
}

/**
 * The org's Activity log for `query`: one id-descending page of rows filtered in SQL, plus — on
 * the first page only — the User, Project and Events facet counts over the scope's UNFILTERED log
 * (the facet passes are given `scopeOf()` and nothing from the query).
 */
export async function queryActivityPage(
	orgId: string,
	query: ActivityQuery = {},
	pageSize = 50,
): Promise<ActivityPage> {
	const db = getServiceDb();
	const limit = query.limit ?? pageSize;
	const scope = scopeOf(orgId, query.projectId);
	const search = searchTerm(query.search);

	const conditions: (SQL | undefined)[] = [
		...scope,
		query.cursor != null ? lt(authzActivityLog.id, query.cursor) : undefined,
		query.from ? gte(authzActivityLog.ts, new Date(query.from)) : undefined,
		query.to ? lte(authzActivityLog.ts, new Date(query.to)) : undefined,
		query.actorIds?.length
			? inArray(authzActivityLog.actor_id, query.actorIds)
			: undefined,
		query.resourceTypes?.length
			? inArray(authzActivityLog.resource_type, query.resourceTypes)
			: undefined,
		query.resourceIds?.length
			? inArray(authzActivityLog.resource_id, query.resourceIds)
			: undefined,
		query.decision != null ? eq(authzActivityLog.decision, query.decision) : undefined,
	];
	if (search) {
		const like = likeTerm(search);
		conditions.push(
			or(
				ilike(user.name, like),
				ilike(user.email, like),
				ilike(authzActivityLog.action, like),
				ilike(authzActivityLog.resource_type, like),
			),
		);
	}

	// Fetch one extra row to detect whether a further page exists.
	const rowsPass = db
		.select(activitySelect())
		.from(authzActivityLog)
		.leftJoin(user, eq(authzActivityLog.actor_id, user.id))
		.where(and(...conditions))
		.orderBy(desc(authzActivityLog.id))
		.limit(limit + 1);

	const firstPage = query.cursor == null;
	const [rows, facets] = await Promise.all([
		rowsPass,
		firstPage ? queryActivityFacets(orgId, query.projectId) : Promise.resolve(null),
	]);

	const hasMore = rows.length > limit;
	const page = hasMore ? rows.slice(0, limit) : rows;
	const nextCursor = hasMore ? page[page.length - 1].id : null;

	return {
		rows: page.map(
			(r): ActivityRow => ({ ...r, id: String(r.id), ts: r.ts.toISOString() }),
		),
		nextCursor,
		facets,
	};
}

/**
 * The three facet passes, each a GROUP BY over the scope's unfiltered log. The Project pass is
 * skipped on a project's own feed: its scope already IS one project, and the facet is hidden.
 */
async function queryActivityFacets(
	orgId: string,
	projectId: string | undefined,
): Promise<ActivityFacets> {
	const db = getServiceDb();
	const scope = and(...scopeOf(orgId, projectId));

	const actorPass = db
		.select({
			value: authzActivityLog.actor_id,
			name: user.name,
			email: user.email,
			count: count(),
		})
		.from(authzActivityLog)
		.leftJoin(user, eq(authzActivityLog.actor_id, user.id))
		.where(scope)
		.groupBy(authzActivityLog.actor_id, user.name, user.email);

	const eventPass = db
		.select({
			resourceType: authzActivityLog.resource_type,
			decision: authzActivityLog.decision,
			count: count(),
		})
		.from(authzActivityLog)
		.where(scope)
		.groupBy(authzActivityLog.resource_type, authzActivityLog.decision);

	// An inner join to the ORG's projects: the Project facet filters `resource_id IN (…)`, so a
	// project's count is every event whose resource is that project — the same rows the filter
	// then selects. The join also keeps another org's project id from ever being labelled.
	const projectPass = projectId
		? Promise.resolve([])
		: db
				.select({
					value: authzActivityLog.resource_id,
					name: projects.project_name,
					count: count(),
				})
				.from(authzActivityLog)
				.innerJoin(
					projects,
					and(
						eq(authzActivityLog.resource_id, projects.id),
						eq(projects.org_id, orgId),
					),
				)
				.where(scope)
				.groupBy(authzActivityLog.resource_id, projects.project_name);

	const [actorRows, eventRows, projectRows] = await Promise.all([
		actorPass,
		eventPass,
		projectPass,
	]);

	const actorLabels = new Map<string, string>();
	for (const r of actorRows) {
		const label = r.name?.trim() || r.email;
		if (r.value && label) actorLabels.set(r.value, label);
	}
	const projectLabels = new Map<string, string>();
	for (const r of projectRows) {
		if (r.value && r.name) projectLabels.set(r.value, r.name);
	}

	return {
		actors: asOptions(countsOf(actorRows), (v) => actorLabels.get(v) ?? null),
		projects: asOptions(countsOf(projectRows), (v) => projectLabels.get(v) ?? null),
		resourceTypes: asOptions(
			countsOf(eventRows.map((r) => ({ value: r.resourceType, count: r.count }))),
		),
		decisions: orderedOptions(
			countsOf(
				eventRows.map((r) => ({
					value: r.decision ? "allow" : "deny",
					count: r.count,
				})),
			),
			DECISIONS,
		),
	};
}
