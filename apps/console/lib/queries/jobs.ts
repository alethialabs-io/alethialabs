// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The jobs list's server half (lib/query/README.md → "Server-side filters" and "Paging"; #7483).
// Both jobs routes read through it: the org route with no project, a project's route with its
// project as the SCOPE.
//
// TWO PASSES, AND WHICH PREDICATES EACH ONE SEES IS THE POINT:
//
// | Pass | Scope (visibility, project) | Filters | Cursor |
// | --- | --- | --- | --- |
// | rows — newest first, `limit + 1` | yes | yes | yes |
// | facets — one `GROUP BY`, first page only | yes | **no** | no |
//
// The scope is the reader's visible jobs (`jobVisibleTo`, handed in by the procedure) and, on a
// project's list, that project. Because the facet pass sees the scope and nothing else, an option
// never disappears when it is picked, and a project's list never counts or offers another project's
// jobs. The same pass answers `universeEmpty`: no group at all means the scope holds no jobs, which
// is the first-run state — never a count (README → "Counts").
//
// There is no "matched" count and no total any more. The list used to read the newest `limit` rows
// and grow `limit` on every "Show more" up to a 500-row cap, so each click re-read the whole window
// and jobs past the cap were unreachable (#7483). Now each page is the rows strictly after the
// previous page's last row by `(created_at truncated to ms, id)` — the shared keyset codec
// (`lib/queries/keyset.ts`) — so the oldest job in a scope is as reachable as the newest.

import { and, count, eq, gte, ilike, inArray, lte, or, type SQL } from "drizzle-orm";
import type { getServiceDb } from "@/lib/db";
import { likeTerm } from "@/lib/db/like";
import { cloudIdentities, jobs, projectEnvironments, projects, runners } from "@/lib/db/schema";
import { provisionJobStatus, provisionJobType } from "@/lib/db/schema/enums";
import { redactJobRow } from "@/lib/jobs/redact-snapshot";
import { type FacetOption, narrowTo, searchTerm } from "@/lib/queries/facets";
import {
	type KeysetListPage,
	type KeysetPageRequest,
	keysetAfter,
	keysetFetchLimit,
	keysetListPage,
	keysetOrderBy,
	keysetPage,
	keysetSortKey,
} from "@/lib/queries/keyset";

type Db = ReturnType<typeof getServiceDb>;
/** The scoped transaction handed to a `withScope` callback. */
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * The list's SCOPE: predicates that bound the universe, applied to BOTH passes. Never a filter
 * (lib/query/README.md, "Scope is a predicate, never a filter").
 */
export interface JobsScope {
	/** The reader's job visibility (`jobVisibleTo`): job visibility follows project visibility. */
	visible: SQL | undefined;
	/** The project whose jobs list this is, on a project's route. */
	projectId?: string;
}

/**
 * The list's FILTERS: everything the bar can pick. Optional, and enum-shaped values are narrowed to
 * known members before SQL, so a stale link's unknown value drops out instead of failing the read.
 */
export interface JobsFilterQuery {
	/** ISO bounds on created_at (inclusive). An invalid bound is ignored, never a 500. */
	from?: string;
	to?: string;
	authors?: string[];
	envs?: string[];
	projects?: string[];
	statuses?: string[];
	types?: string[];
	/** Free-text contains-match over project name/slug, environment + runner names, and the error
	 * message (jobs carry no commit/branch column to search). */
	search?: string;
}

/** The jobs list's facet options, each counted over the SCOPE, whatever the filters. */
export interface JobsFacets {
	authors: FacetOption[];
	envs: FacetOption[];
	projects: FacetOption[];
	statuses: FacetOption[];
	types: FacetOption[];
}

/** Parse an ISO bound; undefined when absent/invalid (an invalid bound must not 500). */
function parseBound(iso?: string): Date | undefined {
	if (!iso) return undefined;
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? undefined : d;
}

/** A facet's running tally: each value's label and how many jobs in the scope carry it. */
type FacetTally = Map<string, { label: string | null; count: number }>;

/** Adds `n` jobs to `value`'s tally; a row the facet does not apply to (null) is skipped. */
function bump(tally: FacetTally, value: string | null, n: number, label: string | null = null): void {
	if (!value) return;
	const current = tally.get(value);
	if (current) current.count += n;
	else tally.set(value, { label, count: n });
}

/** A tally as facet options, sorted by label (falling back to the value). */
function asFacetOptions(tally: FacetTally): FacetOption[] {
	return [...tally.entries()]
		.map(([value, { label, count: n }]) => ({ value, label, count: n }))
		.sort((a, b) => (a.label ?? a.value).localeCompare(b.label ?? b.value));
}

/** The list's sort key: created_at truncated to ms — read by the ORDER BY and the cursor alike. */
const jobSortKey = keysetSortKey(jobs.created_at);

/** The scope predicate, built once and handed to both passes. */
function scopePredicate(scope: JobsScope): SQL | undefined {
	return and(scope.visible, scope.projectId ? eq(jobs.project_id, scope.projectId) : undefined);
}

/** The filter predicates — the rows pass only. */
function filterPredicates(query: JobsFilterQuery): (SQL | undefined)[] {
	const statuses = narrowTo(provisionJobStatus.enumValues, query.statuses);
	const types = narrowTo(provisionJobType.enumValues, query.types);
	const from = parseBound(query.from);
	const to = parseBound(query.to);
	const search = searchTerm(query.search);
	const like = search ? likeTerm(search) : undefined;
	return [
		from ? gte(jobs.created_at, from) : undefined,
		to ? lte(jobs.created_at, to) : undefined,
		query.authors?.length ? inArray(jobs.user_id, query.authors) : undefined,
		query.envs?.length ? inArray(jobs.environment_id, query.envs) : undefined,
		query.projects?.length ? inArray(jobs.project_id, query.projects) : undefined,
		statuses ? inArray(jobs.status, statuses) : undefined,
		types ? inArray(jobs.job_type, types) : undefined,
		like
			? or(
					ilike(projects.project_name, like),
					ilike(projects.slug, like),
					ilike(projectEnvironments.name, like),
					ilike(runners.name, like),
					ilike(jobs.error_message, like),
				)
			: undefined,
	];
}

/** The rows pass: one page of filtered jobs strictly after the cursor, with the joined names. */
function rowsPass(tx: Tx, scope: JobsScope, query: JobsFilterQuery, page: KeysetPageRequest) {
	return tx
		.select({
			job: jobs,
			project_name: projects.project_name,
			project_slug: projects.slug,
			runner_name: runners.name,
			runner_version: runners.version,
			cloud_provider: cloudIdentities.provider,
			cloud_identity_status: cloudIdentities.status,
			environment_name: projectEnvironments.name,
			environment_stage: projectEnvironments.stage,
		})
		.from(jobs)
		.leftJoin(projects, eq(jobs.project_id, projects.id))
		.leftJoin(runners, eq(jobs.runner_id, runners.id))
		.leftJoin(cloudIdentities, eq(jobs.cloud_identity_id, cloudIdentities.id))
		.leftJoin(projectEnvironments, eq(jobs.environment_id, projectEnvironments.id))
		.where(
			and(
				scopePredicate(scope),
				...filterPredicates(query),
				keysetAfter(jobSortKey, jobs.id, page.cursor),
			),
		)
		// `id` breaks ties, so two jobs created in the same millisecond keep one order and a page
		// boundary between them neither skips nor repeats a job.
		.orderBy(...keysetOrderBy(jobSortKey, jobs.id))
		.limit(keysetFetchLimit(page.limit));
}

/** The facet pass: one grouped read over the SCOPE (no filter, no cursor) feeding every facet. */
function facetPass(tx: Tx, scope: JobsScope) {
	return tx
		.select({
			status: jobs.status,
			job_type: jobs.job_type,
			user_id: jobs.user_id,
			project_id: jobs.project_id,
			project_name: projects.project_name,
			environment_id: jobs.environment_id,
			environment_name: projectEnvironments.name,
			environment_stage: projectEnvironments.stage,
			jobs: count(),
		})
		.from(jobs)
		.leftJoin(projects, eq(jobs.project_id, projects.id))
		.leftJoin(projectEnvironments, eq(jobs.environment_id, projectEnvironments.id))
		.where(scopePredicate(scope))
		.groupBy(
			jobs.status,
			jobs.job_type,
			jobs.user_id,
			jobs.project_id,
			projects.project_name,
			jobs.environment_id,
			projectEnvironments.name,
			projectEnvironments.stage,
		);
}

/** The facet pass's groups summed into every facet, and whether the scope holds any job at all. */
function tallyFacets(groups: Awaited<ReturnType<typeof facetPass>>): { facets: JobsFacets; universeEmpty: boolean } {
	const authorF: FacetTally = new Map();
	const envF: FacetTally = new Map();
	const projectF: FacetTally = new Map();
	const statusF: FacetTally = new Map();
	const typeF: FacetTally = new Map();
	let any = false;
	for (const g of groups) {
		const n = Number(g.jobs);
		if (n > 0) any = true;
		bump(authorF, g.user_id, n);
		bump(
			envF,
			g.environment_id,
			n,
			g.environment_name
				? g.environment_stage
					? `${g.environment_name} (${g.environment_stage})`
					: g.environment_name
				: null,
		);
		bump(projectF, g.project_id, n, g.project_name);
		bump(statusF, g.status, n);
		bump(typeF, g.job_type, n);
	}
	return {
		facets: {
			authors: asFacetOptions(authorF),
			envs: asFacetOptions(envF),
			projects: asFacetOptions(projectF),
			statuses: asFacetOptions(statusF),
			types: asFacetOptions(typeF),
		},
		universeEmpty: !any,
	};
}

/** One fetched row flattened for the list, the job-snapshot filter kept on every user-facing row. */
function toListRow(r: Awaited<ReturnType<typeof rowsPass>>[number]) {
	return {
		...redactJobRow(r.job),
		project_name: r.project_name ?? null,
		project_slug: r.project_slug ?? null,
		runner_name: r.runner_name ?? null,
		runner_version: r.runner_version ?? null,
		cloud_provider: r.cloud_provider ?? null,
		cloud_identity_status: r.cloud_identity_status ?? null,
		environment_name: r.environment_name ?? null,
		environment_stage: r.environment_stage ?? null,
	};
}

/** A row of the jobs list as the browser receives it. */
export type JobListRow = ReturnType<typeof toListRow>;

/**
 * One page of the jobs list (lib/query/README.md → "Paging"): at most `page.limit` jobs strictly
 * after `page.cursor`, newest first (ties by id), with `nextCursor` exact (one extra row read), and —
 * on the FIRST page only — the facet pass over the unfiltered scope and `universeEmpty`.
 *
 * Nothing here is unbounded: the rows pass reads `limit + 1` rows, and the facet pass returns one
 * row per distinct (status, type, author, project, environment), not one per job.
 */
export async function queryJobsPage(
	tx: Tx,
	scope: JobsScope,
	query: JobsFilterQuery,
	page: KeysetPageRequest,
): Promise<KeysetListPage<JobListRow, JobsFacets>> {
	const firstPage = page.cursor === undefined;
	// Both passes are handed to ONE `Promise.all`, rows first: they run concurrently on the
	// transaction, and a later page issues the rows pass alone.
	const [fetched, groups] = await Promise.all([
		rowsPass(tx, scope, query, page),
		firstPage ? facetPass(tx, scope) : null,
	]);
	const cut = keysetPage(fetched, page.limit, (r) => ({ at: r.job.created_at, id: r.job.id }));
	return keysetListPage(
		{ rows: cut.rows.map(toListRow), nextCursor: cut.nextCursor },
		groups === null ? null : tallyFacets(groups),
	);
}
