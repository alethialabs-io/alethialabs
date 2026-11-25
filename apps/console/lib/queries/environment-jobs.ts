// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";
import { and, eq } from "drizzle-orm";
import type { EnvironmentJob, EnvironmentJobsPage } from "@/app/server/actions/canvas-jobs";
import { getServiceDb } from "@/lib/db";
import { jobs } from "@/lib/db/schema";
import {
	type KeysetPageRequest,
	keysetAfter,
	keysetFetchLimit,
	keysetListPage,
	keysetOrderBy,
	keysetPage,
	keysetSortKey,
} from "./keyset";

// The canvas Activity card's read: one environment's jobs, newest first, on the console's one
// keyset contract (`./keyset.ts`, epic #7481 / LST-10 #7492). It used to carry its own cursor — a
// raw `created_at|id` string compared on the microsecond column, which a JS `Date` had already cut
// to milliseconds, so a job in the cursor's millisecond but a later microsecond could fall on the
// wrong side of a page boundary — and read a malformed cursor as page one. The shared codec orders
// and compares on the ms-truncated key, and a malformed cursor is refused at the input schema.
//
// The card has no filter bar, so there is no facet pass: `facets` is always null, and the
// universe-empty answer on page one is simply "page one came back empty" (with no filters, the
// filtered and unfiltered universes are the same set).
//
// Service path: the caller (`readEnvironmentJobs`) has already authorized `view` on the project and
// checked the environment is the project's, in the actor's org. The org predicate is repeated here
// because the service role bypasses RLS.

/** The one environment the card shows, in the actor's org — scope, never a filter. */
export interface EnvironmentJobsScope {
	orgId: string;
	projectId: string;
	environmentId: string;
}

/** One keyset page of the scope's jobs (see the module comment). */
export async function queryEnvironmentJobsPage(
	scope: EnvironmentJobsScope,
	page: KeysetPageRequest,
): Promise<EnvironmentJobsPage> {
	const sortKey = keysetSortKey(jobs.created_at);
	const rows = await getServiceDb()
		.select({
			id: jobs.id,
			job_type: jobs.job_type,
			status: jobs.status,
			created_at: jobs.created_at,
			error_message: jobs.error_message,
		})
		.from(jobs)
		.where(
			and(
				eq(jobs.project_id, scope.projectId),
				eq(jobs.environment_id, scope.environmentId),
				eq(jobs.org_id, scope.orgId),
				keysetAfter(sortKey, jobs.id, page.cursor, "uuid"),
			),
		)
		.orderBy(...keysetOrderBy(sortKey, jobs.id))
		.limit(keysetFetchLimit(page.limit));

	const cut = keysetPage(rows, page.limit, (r) => ({ at: r.created_at, id: r.id }));
	// No facet pass (no filter bar), so this is a list builder, not a filter builder.
	const firstPage = page.cursor === undefined ? { facets: null, universeEmpty: cut.rows.length === 0 } : null;
	return keysetListPage(
		{
			rows: cut.rows.map(
				(r): EnvironmentJob => ({
					id: r.id,
					type: r.job_type,
					status: r.status,
					createdAt: r.created_at.toISOString(),
					error: r.error_message,
				}),
			),
			nextCursor: cut.nextCursor,
		},
		firstPage,
	);
}
