// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The jobs list's server half (lib/queries/jobs.ts, #7483) over a recording `tx`
// (`_list-query-db.ts`: every `select()` is its own chain, so the rows pass and the facet pass are
// interrogated separately). Pinned here:
//   · THE FACET SET DOES NOT SHRINK AS THE QUERY NARROWS — the facet pass is handed the scope and
//     nothing else, so its predicate is identical with and without filters;
//   · IT DOES SHRINK WHEN THE SCOPE NARROWS — a project's list counts only that project's jobs;
//   · the page is the shared keyset contract: `limit + 1` rows read, ordered by the ms-truncated
//     created_at then id, a later page strictly after its cursor, `nextCursor` exact, and the facet
//     pass + `universeEmpty` on the FIRST page only. There is no row cap: page N+1 is the same read
//     as page 2, so a job past any number of pages is reachable (the old list stopped at 500).

import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { type JobsFilterQuery, queryJobsPage } from "@/lib/queries/jobs";
import { decodeKeysetCursor, encodeKeysetCursor, type KeysetPosition } from "@/lib/queries/keyset";
import { mockChainDb, type RecordedChain } from "./_list-query-db";

const dialect = new PgDialect();
const VISIBLE = sql.raw("job_visible_to_reader");

/** A chain's WHERE as SQL text and params. */
function whereOf(chain: RecordedChain | undefined): { sql: string; params: unknown[] } {
	const args = chain?.argsOf("where");
	if (!args) throw new Error("the chain was handed no where()");
	return dialect.sqlToQuery(args[0] as never);
}

/** A chain's ORDER BY as SQL text. */
function orderOf(chain: RecordedChain | undefined): string {
	const args = chain?.argsOf("orderBy") ?? [];
	return dialect.sqlToQuery(sql.join(args as never[], sql`, `)).sql;
}

/** A uuid whose trailing digits are `n`. */
function uuid(n: number): string {
	return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

/** One fetched rows-pass row. */
function fetched(n: number, at: string, snapshot: Record<string, unknown> = {}) {
	return {
		job: { id: uuid(n), status: "SUCCESS", job_type: "PLAN", created_at: new Date(at), config_snapshot: snapshot },
		project_name: null,
		project_slug: null,
		runner_name: null,
		runner_version: null,
		cloud_provider: null,
		cloud_identity_status: null,
		environment_name: null,
		environment_stage: null,
	};
}

/** One facet-pass row: a distinct (status, type, author, project, environment) and its job count. */
function group(fields: Record<string, unknown>) {
	return {
		status: "SUCCESS",
		job_type: "PLAN",
		user_id: "u-1",
		project_id: null,
		project_name: null,
		environment_id: null,
		environment_name: null,
		environment_stage: null,
		jobs: 1,
		...fields,
	};
}

const FILTERS: JobsFilterQuery = {
	search: "needle-search",
	authors: ["needle-author"],
	envs: ["needle-env"],
	projects: ["needle-project"],
	statuses: ["FAILED"],
	types: ["DEPLOY"],
	from: "2026-01-01T00:00:00.000Z",
	to: "2026-02-01T00:00:00.000Z",
};
const NEEDLES = ["%needle-search%", "needle-author", "needle-env", "needle-project", "FAILED", "DEPLOY"];

/** Runs one page read over a recording tx and hands back its chains and its answer. */
async function read(
	query: JobsFilterQuery,
	options: { projectId?: string; cursor?: KeysetPosition; limit?: number; sets?: unknown[][] } = {},
) {
	const { db, chains } = mockChainDb(options.sets ?? [[], []]);
	const page = await queryJobsPage(
		db,
		{ visible: VISIBLE, projectId: options.projectId },
		query,
		{ cursor: options.cursor, limit: options.limit ?? 50 },
	);
	return { page, rows: chains[0], facets: chains[1], chains };
}

describe("queryJobsPage — the facet pass sees the scope and nothing else", () => {
	it("the rows pass carries every filter; the facet pass carries none of them", async () => {
		const { rows, facets } = await read(FILTERS);
		// The control: a builder that ignored its query would pass the second line.
		expect(NEEDLES.filter((n) => !whereOf(rows).params.includes(n))).toEqual([]);
		expect(NEEDLES.filter((n) => whereOf(facets).params.includes(n))).toEqual([]);
	});

	it("facets do not shrink as the query narrows: the facet predicate is the unfiltered one, and the same groups give the same options", async () => {
		const groups = [
			group({ status: "FAILED", project_id: "p-1", project_name: "Web", jobs: 4 }),
			group({ status: "SUCCESS", project_id: "p-2", project_name: "Api", job_type: "DEPLOY", jobs: 3 }),
		];
		const narrowed = await read(FILTERS, { sets: [[], groups] });
		const pristine = await read({}, { sets: [[], groups] });
		// The rows pass DID narrow — otherwise the equality below would prove nothing.
		expect(whereOf(narrowed.rows)).not.toEqual(whereOf(pristine.rows));
		expect(whereOf(narrowed.facets)).toEqual(whereOf(pristine.facets));
		expect(narrowed.page.facets).toEqual(pristine.page.facets);
		expect(narrowed.page.facets?.projects.map((o) => o.value)).toEqual(["p-2", "p-1"]);
	});

	it("facets DO shrink to the project when the scope narrows: the project reaches both passes", async () => {
		const scoped = await read({}, { projectId: "proj-scope" });
		const org = await read({});
		expect(whereOf(scoped.facets).params).toContain("proj-scope");
		expect(whereOf(scoped.rows).params).toContain("proj-scope");
		expect(whereOf(org.facets).params).not.toContain("proj-scope");
		expect(whereOf(scoped.facets)).not.toEqual(whereOf(org.facets));
		// And the scope is not a filter: filters on a project's list leave its facet pass alone.
		const scopedFiltered = await read(FILTERS, { projectId: "proj-scope" });
		expect(whereOf(scopedFiltered.facets)).toEqual(whereOf(scoped.facets));
	});

	it("visibility is part of the scope: both passes carry it", async () => {
		const { rows, facets } = await read(FILTERS);
		expect(whereOf(rows).sql).toContain("job_visible_to_reader");
		expect(whereOf(facets).sql).toContain("job_visible_to_reader");
	});

	it("sums the grouped facet pass into every facet (job counts, never the number of groups)", async () => {
		const { page } = await read(
			{},
			{
				sets: [
					[],
					[
						group({ status: "FAILED", project_id: "p-1", project_name: "Web", environment_id: "e-1", environment_name: "prod", environment_stage: "production", jobs: 4 }),
						group({ status: "FAILED", project_id: "p-1", project_name: "Web", environment_id: "e-1", environment_name: "prod", environment_stage: "production", job_type: "DEPLOY", jobs: 2 }),
						group({ jobs: 3 }),
					],
				],
			},
		);
		expect(page.facets).toEqual({
			authors: [{ value: "u-1", label: null, count: 9 }],
			envs: [{ value: "e-1", label: "prod (production)", count: 6 }],
			projects: [{ value: "p-1", label: "Web", count: 6 }],
			statuses: [
				{ value: "FAILED", label: null, count: 6 },
				{ value: "SUCCESS", label: null, count: 3 },
			],
			types: [
				{ value: "DEPLOY", label: null, count: 2 },
				{ value: "PLAN", label: null, count: 7 },
			],
		});
		expect(page.universeEmpty).toBe(false);
	});

	it("an empty scope is universeEmpty — a boolean, never a count", async () => {
		const { page } = await read({});
		expect(page).toEqual({
			rows: [],
			nextCursor: null,
			facets: { authors: [], envs: [], projects: [], statuses: [], types: [] },
			universeEmpty: true,
		});
	});
});

describe("queryJobsPage — the keyset page", () => {
	it("page one reads limit + 1 rows, newest first with the id breaking ties, on the ms-truncated key", async () => {
		const { rows } = await read({}, { limit: 50 });
		expect(rows?.argsOf("limit")).toEqual([51]);
		expect(orderOf(rows)).toBe(
			`date_trunc('milliseconds', "jobs"."created_at") desc, "jobs"."id" desc`,
		);
		// Page one has no cursor predicate.
		expect(whereOf(rows).sql).not.toContain("::timestamptz");
	});

	it("a full page mints nextCursor from its LAST KEPT row; the extra row is not returned", async () => {
		const at = "2026-11-20T10:00:00.000Z";
		// Three rows at ONE instant: the tie is broken by id (descending), as the ORDER BY says.
		const sets = [[fetched(3, at), fetched(2, at), fetched(1, at)], []];
		const { page } = await read({}, { limit: 2, sets });
		expect(page.rows.map((r) => r.id)).toEqual([uuid(3), uuid(2)]);
		expect(page.nextCursor).not.toBeNull();
		expect(decodeKeysetCursor(page.nextCursor ?? "")).toEqual({ at, id: uuid(2) });
	});

	it("a short page is the end: nextCursor is null", async () => {
		const { page } = await read({}, { limit: 2, sets: [[fetched(1, "2026-11-20T10:00:00.000Z")], []] });
		expect(page.nextCursor).toBeNull();
	});

	it("a cursor carries microseconds through ms truncation: the cursor's instant is exactly the row's ms", async () => {
		// Postgres hands back a Date (ms); the cursor must render that ms, and the predicate compares
		// it to the ms-truncated column — the same expression the ORDER BY reads.
		const sets = [[fetched(2, "2026-11-20T10:00:00.123Z"), fetched(1, "2026-11-20T10:00:00.123Z")], []];
		const { page } = await read({}, { limit: 1, sets });
		expect(decodeKeysetCursor(page.nextCursor ?? "")?.at).toBe("2026-11-20T10:00:00.123Z");
	});

	it("a later page is strictly after its cursor as ONE row-value comparison, and runs no facet pass", async () => {
		const cursor = decodeKeysetCursor(encodeKeysetCursor({ at: "2026-11-20T10:00:00.000Z", id: uuid(7) }));
		if (cursor === null) throw new Error("the codec refused its own cursor");
		const { page, rows, chains } = await read(FILTERS, { cursor, sets: [[]] });
		const where = whereOf(rows);
		expect(where.sql).toContain(
			`(date_trunc('milliseconds', "jobs"."created_at"), "jobs"."id") < ($`,
		);
		expect(where.params).toEqual(expect.arrayContaining(["2026-11-20T10:00:00.000Z", uuid(7)]));
		// Filters still apply on a later page.
		expect(NEEDLES.filter((n) => !where.params.includes(n))).toEqual([]);
		expect(chains).toHaveLength(1);
		expect(page.facets).toBeNull();
		expect(page.universeEmpty).toBeNull();
	});

	it("has no row cap: the 20th page is the same bounded read as the 2nd", async () => {
		const at = (i: number) => new Date(Date.UTC(2025, 0, 1) + i * 1000).toISOString();
		const second = await read({}, { cursor: { at: at(1000), id: uuid(1000) }, sets: [[]] });
		const twentieth = await read({}, { cursor: { at: at(50), id: uuid(50) }, sets: [[]] });
		expect(twentieth.rows?.argsOf("limit")).toEqual(second.rows?.argsOf("limit"));
		expect(twentieth.rows?.argsOf("limit")).toEqual([51]);
		expect(twentieth.rows?.called("offset")).toBe(false);
	});

	it("keeps the job-snapshot filter on every row", async () => {
		const SENTINEL = "SENTINEL-jobs-page-7483";
		const row = fetched(1, "2026-11-20T10:00:00.000Z", { runner_id: "r-1", runner_token: SENTINEL });
		const { page } = await read({}, { sets: [[row], []] });
		expect(JSON.stringify(page)).not.toContain(SENTINEL);
	});
});
