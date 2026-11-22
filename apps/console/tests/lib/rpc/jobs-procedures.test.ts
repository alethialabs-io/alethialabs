// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The jobs readers (#6121) over a mocked boundary: the authz guard, the scoped transaction (a
// thenable drizzle chain — each `await` takes the next seeded result set) and the visibility
// predicate. What is pinned here: every reader puts job visibility into EVERY query it runs (the
// facet pass included), the read shapes and their join fallbacks, and that a job the reader cannot
// see is refused as not-found — absent and invisible alike. The predicate's SQL is
// tests/lib/jobs/visibility.test.ts; that it hides the right rows against real Postgres is
// tests/integration/jobs-visibility.test.ts.

import { is, SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/authz/guard", () => ({ authorize: vi.fn() }));
// The PDP behind the page reader's controls: every question is recorded and answered from `allowed`.
const pdp = vi.hoisted(() => ({
	asked: [] as Array<{ action: string; resource: { type: string; id?: string } }>,
	allowed: (_check: { action: string; resource: { type: string; id?: string } }): boolean => true,
}));
vi.mock("@/lib/authz", () => ({
	getPdp: () => ({
		bulkCheck: async (_actor: unknown, checks: Array<{ action: string; resource: { type: string; id?: string } }>) => {
			pdp.asked.push(...checks);
			return checks.map((check) => ({ allowed: pdp.allowed(check) }));
		},
	}),
}));
vi.mock("@/lib/db", () => ({ withScope: vi.fn() }));
vi.mock("@/lib/jobs/visibility", async () => {
	const { sql } = await import("drizzle-orm");
	const visible = sql.raw("job_visible_to_reader");
	return { jobVisibleTo: vi.fn(async () => visible) };
});

import { ActionRefusal } from "@/lib/actions/result";
import { authorize } from "@/lib/authz/guard";
import { withScope } from "@/lib/db";
import { jobVisibleTo } from "@/lib/jobs/visibility";
import {
	readJob,
	readJobDetail,
	readJobLogsHead,
	readJobStatus,
	readJobsPage,
	readPlanResult,
	readProjectJobs,
} from "@/lib/rpc/procedures/jobs";

const ACTOR = { userId: "user-1", orgId: "org-1" };
const dialect = new PgDialect();

/**
 * A drizzle-ish chain; each `await` resolves the next seeded result set. Records every `.where()`
 * and `.limit()` argument, in the order the queries were BUILT — which for `readJobsPage` is rows,
 * matched count, facets.
 */
function mockDb(resultSets: unknown[][]) {
	const wheres: unknown[] = [];
	const limits: unknown[] = [];
	let i = 0;
	const db: Record<string, unknown> = {};
	Object.assign(db, {
		select: () => db,
		from: () => db,
		leftJoin: () => db,
		where: (w: unknown) => {
			wheres.push(w);
			return db;
		},
		limit: (n: unknown) => {
			limits.push(n);
			return db;
		},
		orderBy: () => db,
		groupBy: () => db,
		then: (resolve: (v: unknown) => void) => resolve(resultSets[i++] ?? []),
	});
	vi.mocked(withScope).mockImplementation(((_scope: unknown, cb: (tx: unknown) => unknown) => cb(db)) as never);
	return { wheres, limits };
}

/** A recorded `.where()` argument as SQL text and its parameters. */
function rendered(where: unknown): { sql: string; params: unknown[] } {
	if (!is(where, SQL)) throw new Error("a recorded where() argument is not SQL");
	return dialect.sqlToQuery(where);
}

/** Whether a recorded `.where()` argument carries the visibility predicate. */
function carriesVisibility(where: unknown): boolean {
	return is(where, SQL) && dialect.sqlToQuery(where).sql.includes("job_visible_to_reader");
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(authorize).mockResolvedValue(ACTOR as never);
	pdp.asked = [];
	pdp.allowed = () => true;
});

describe("job visibility follows project visibility, in every jobs read", () => {
	it.each([
		// [reader, run, result sets, how many of its queries read `jobs`]
		["readJob", () => readJob("job-1"), [[{ job: { id: "job-1" } }]], 1],
		["readJobStatus", () => readJobStatus("job-1"), [[{ status: "QUEUED" }]], 1],
		["readPlanResult", () => readPlanResult("job-1"), [[{ status: "SUCCESS" }]], 1],
		// The log read is gated by the job read before it; the log rows follow their job (RLS).
		["readJobLogsHead", () => readJobLogsHead("job-1"), [[{ id: "job-1" }], []], 1],
		["readProjectJobs", () => readProjectJobs("proj-1"), [[]], 1],
		["readJobDetail", () => readJobDetail("job-1"), [[{ job: { id: "job-1", job_type: "DEPLOY", status: "QUEUED", project_id: null, environment_id: null, config_snapshot: {} } }]], 1],
		// All three passes: the rows, the matched count AND the facet counts, or a hidden project's
		// name leaks as a facet and its jobs are counted.
		["readJobsPage", () => readJobsPage({}), [[], [], []], 3],
	] as const)("%s filters by the reader's visible projects", async (_name, run, sets, jobsQueries) => {
		const { wheres } = mockDb(sets.map((s) => [...s]));
		await run();
		expect(jobVisibleTo).toHaveBeenCalledWith(ACTOR);
		expect(wheres.filter(carriesVisibility)).toHaveLength(jobsQueries);
		expect(carriesVisibility(wheres[0])).toBe(true);
	});
});

describe("readJob", () => {
	it("returns the job with its project and environment names", async () => {
		mockDb([[{ job: { id: "job-1", status: "QUEUED", config_snapshot: {} }, project_name: "Web", project_slug: "web", environment_name: "prod" }]]);
		expect(await readJob("job-1")).toEqual({
			id: "job-1",
			status: "QUEUED",
			config_snapshot: {},
			project_name: "Web",
			project_slug: "web",
			environment_name: "prod",
		});
		expect(authorize).toHaveBeenCalledWith("view", { type: "job", id: "job-1" });
	});

	it("falls back to null for a project-less job's names", async () => {
		mockDb([[{ job: { id: "job-1" }, project_name: null, project_slug: null, environment_name: null }]]);
		expect(await readJob("job-1")).toMatchObject({ project_name: null, project_slug: null, environment_name: null });
	});

	it("is null for a job the reader cannot see", async () => {
		mockDb([[]]);
		expect(await readJob("job-x")).toBeNull();
	});
});

describe("a job the reader cannot see is refused as not-found", () => {
	it.each([
		["readJobStatus", () => readJobStatus("job-x")],
		["readPlanResult", () => readPlanResult("job-x")],
		["readJobLogsHead", () => readJobLogsHead("job-x")],
	])("%s", async (_name, run) => {
		mockDb([[]]);
		const error = await run().then(() => null, (e: unknown) => e);
		expect(error).toBeInstanceOf(ActionRefusal);
		expect(error).toMatchObject({ kind: "not-found", message: "Job not found." });
	});

	it("propagates an authorization failure before any query", async () => {
		vi.mocked(authorize).mockRejectedValueOnce(new Error("Forbidden"));
		await expect(readJobStatus("job-1")).rejects.toThrow(/Forbidden/);
		expect(withScope).not.toHaveBeenCalled();
	});
});

describe("readJobLogsHead", () => {
	it("returns the lines oldest first with ISO timestamps, and the last id the stream resumes after", async () => {
		mockDb([
			[{ id: "job-1" }],
			[
				{ id: 7, log_chunk: "a", stream_type: "STDOUT", created_at: new Date("2026-10-20T10:00:00.000Z") },
				{ id: 9, log_chunk: "b", stream_type: "STDERR", created_at: new Date("2026-10-20T10:00:01.000Z") },
			],
		]);
		expect(await readJobLogsHead("job-1")).toEqual({
			lines: [
				{ id: 7, log_chunk: "a", stream_type: "STDOUT", created_at: "2026-10-20T10:00:00.000Z" },
				{ id: 9, log_chunk: "b", stream_type: "STDERR", created_at: "2026-10-20T10:00:01.000Z" },
			],
			lastId: 9,
			final: false,
		});
	});

	it("resumes from zero for a job with no log yet", async () => {
		mockDb([[{ id: "job-1" }], []]);
		expect(await readJobLogsHead("job-1")).toEqual({ lines: [], lastId: 0, final: false });
	});

	// `final` is what lets the page open NO stream for a finished job: it must be true only when
	// nothing more can arrive.
	it.each([
		["a running job", { status: "PROCESSING", completed_at: null }, false],
		["a job that finished a moment ago, whose runner may still be flushing", { status: "SUCCESS", completed_at: new Date() }, false],
		["a finished job with no completion time", { status: "CANCELLED", completed_at: null }, false],
		["a job that finished long ago", { status: "FAILED", completed_at: new Date("2026-01-01T00:00:00.000Z") }, true],
	] as const)("the head of %s reads final=%s", async (_name, job, final) => {
		mockDb([[{ id: "job-1", ...job }], [{ id: 1, log_chunk: "a", stream_type: "STDOUT", created_at: new Date("2026-01-01T00:00:00.000Z") }]]);
		expect((await readJobLogsHead("job-1")).final).toBe(final);
	});

	it("is not final when the read came back at its limit: the job has more lines than the head holds", async () => {
		const full = Array.from({ length: 2_000 }, (_, n) => ({
			id: n + 1,
			log_chunk: "x",
			stream_type: "STDOUT",
			created_at: new Date("2026-01-01T00:00:00.000Z"),
		}));
		mockDb([[{ id: "job-1", status: "SUCCESS", completed_at: new Date("2026-01-01T00:00:00.000Z") }], full]);
		const head = await readJobLogsHead("job-1");
		expect(head.lines).toHaveLength(2_000);
		expect(head.final).toBe(false);
	});
});

describe("readJobDetail — the job as its page reads it", () => {
	const ROW = { project_name: "Web", project_slug: "web", environment_name: "prod" };

	it("carries the job, its names, no approval for a job that is not a plan, and the reader's controls", async () => {
		mockDb([[{ job: { id: "job-1", job_type: "DEPLOY", status: "PROCESSING", project_id: "p-1", environment_id: "e-1", config_snapshot: {} }, ...ROW }]]);
		expect(await readJobDetail("job-1")).toEqual({
			id: "job-1",
			job_type: "DEPLOY",
			status: "PROCESSING",
			project_id: "p-1",
			environment_id: "e-1",
			config_snapshot: {},
			...ROW,
			approval: null,
			can: { cancel: true, rerun: true, deploy: false },
		});
	});

	it("is null for a job the reader cannot see, and asks the PDP nothing about it", async () => {
		mockDb([[]]);
		expect(await readJobDetail("job-x")).toBeNull();
		expect(pdp.asked).toEqual([]);
	});

	it("asks each control the question its write asks", async () => {
		mockDb([[{ job: { id: "job-1", job_type: "PLAN", status: "FAILED", project_id: "p-1", environment_id: "e-1", config_snapshot: {} }, ...ROW }]]);
		await readJobDetail("job-1");
		expect(pdp.asked).toEqual([
			// Cancel: `edit` on the job, then the plan permission on its project.
			{ action: "edit", resource: { type: "job", id: "job-1" } },
			{ action: "plan", resource: { type: "project", id: "p-1" } },
			// Re-run: a plan runs again through the project's plan permission.
			{ action: "plan", resource: { type: "project", id: "p-1" } },
			// Deploy from this plan: `deploy` on the project.
			{ action: "deploy", resource: { type: "project", id: "p-1" } },
		]);
	});

	it("a control is false when ANY of its questions is refused, and the others are unaffected", async () => {
		mockDb([[{ job: { id: "job-1", job_type: "PLAN", status: "SUCCESS", project_id: "p-1", environment_id: "e-1", config_snapshot: {} }, ...ROW }], []]);
		// May plan the project and edit jobs; may not deploy.
		pdp.allowed = (check) => check.action !== "deploy";
		expect((await readJobDetail("job-1"))?.can).toEqual({ cancel: true, rerun: true, deploy: false });
	});

	it("a destroy has no re-run to allow, and a job that is not a plan has nothing to deploy from", async () => {
		mockDb([[{ job: { id: "job-1", job_type: "DESTROY", status: "FAILED", project_id: "p-1", environment_id: "e-1", config_snapshot: {} }, ...ROW }]]);
		expect((await readJobDetail("job-1"))?.can).toEqual({ cancel: true, rerun: false, deploy: false });
		expect(pdp.asked.map((c) => c.action)).toEqual(["edit", "destroy"]);
	});

	it("a succeeded plan carries the newest request to deploy from it", async () => {
		mockDb([
			[{ job: { id: "job-1", job_type: "PLAN", status: "SUCCESS", project_id: "p-1", environment_id: "e-1", config_snapshot: {} }, ...ROW }],
			[
				{
					operation: "deploy",
					status: "pending",
					created_at: new Date("2026-11-20T10:00:00.000Z"),
					expires_at: new Date("2026-11-20T11:00:00.000Z"),
					decided_at: null,
					consumed_job_id: null,
				},
			],
		]);
		expect((await readJobDetail("job-1"))?.approval).toEqual({
			operation: "deploy",
			status: "pending",
			requested_at: "2026-11-20T10:00:00.000Z",
			expires_at: "2026-11-20T11:00:00.000Z",
			decided_at: null,
			consumed_job_id: null,
		});
	});

	it("a succeeded plan nobody asked to deploy from has no approval", async () => {
		mockDb([[{ job: { id: "job-1", job_type: "PLAN", status: "SUCCESS", project_id: "p-1", environment_id: "e-1", config_snapshot: {} }, ...ROW }], []]);
		expect((await readJobDetail("job-1"))?.approval).toBeNull();
	});

	it("never lets a deny-listed snapshot key out", async () => {
		mockDb([[{ job: { id: "job-1", job_type: "DEPLOY", status: "SUCCESS", project_id: null, environment_id: null, config_snapshot: { runner_token: "SENTINEL-detail", region: "eu" } }, ...ROW }]]);
		const job = await readJobDetail("job-1");
		expect(job?.config_snapshot).toEqual({ region: "eu" });
		expect(JSON.stringify(job)).not.toContain("SENTINEL-detail");
	});
});

describe("readProjectJobs", () => {
	it("authorizes the project and returns its jobs", async () => {
		mockDb([[{ id: "j-1" }, { id: "j-2" }]]);
		expect(await readProjectJobs("proj-1")).toHaveLength(2);
		expect(authorize).toHaveBeenCalledWith("view", { type: "project", id: "proj-1" });
	});
});

describe("readJobsPage", () => {
	/** One facet-pass row: a distinct (status, type, author, project, environment) and how many jobs carry it. */
	const group = (fields: Record<string, unknown>) => ({
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
	});

	it("flattens the rows, reports the matched count, and sums the grouped facet pass into every facet and the total", async () => {
		mockDb([
			[{ job: { id: "j-1", status: "FAILED" }, project_name: "Web", project_slug: "web", runner_name: null }],
			[{ matched: 1 }],
			[
				group({ status: "FAILED", project_id: "p-1", project_name: "Web", environment_id: "e-1", environment_name: "prod", environment_stage: "production", jobs: 4 }),
				group({ status: "FAILED", project_id: "p-1", project_name: "Web", environment_id: "e-1", environment_name: "prod", environment_stage: "production", job_type: "DEPLOY", jobs: 2 }),
				group({ jobs: 3 }),
			],
		]);
		const page = await readJobsPage({ statuses: ["FAILED"] });
		expect(page.rows[0]).toMatchObject({ id: "j-1", project_name: "Web", runner_name: null, cloud_provider: null });
		expect(page.matched).toBe(1);
		// Counts are the SUM of the groups' job counts, never the number of groups.
		expect(page.total).toBe(9);
		expect(page.facets.projects).toEqual([{ value: "p-1", label: "Web", count: 6 }]);
		expect(page.facets.envs).toEqual([{ value: "e-1", label: "prod (production)", count: 6 }]);
		expect(page.facets.statuses).toEqual([
			{ value: "FAILED", label: null, count: 6 },
			{ value: "SUCCESS", label: null, count: 3 },
		]);
		expect(page.facets.types).toEqual([
			{ value: "DEPLOY", label: null, count: 2 },
			{ value: "PLAN", label: null, count: 7 },
		]);
		expect(page.facets.authors).toEqual([{ value: "u-1", label: null, count: 9 }]);
	});

	it("an empty scope reads zero for both counts", async () => {
		mockDb([[], [], []]);
		const page = await readJobsPage({});
		expect(page).toMatchObject({ rows: [], matched: 0, total: 0 });
	});

	// The console filter standard's server half (lib/query/README.md): a facet's counts come from the
	// scope, never from the rows the filters selected — or the option just picked disappears.
	describe("the facet pass sees the scope and nothing else", () => {
		const FILTERS = {
			search: "needle-search",
			authors: ["needle-author"],
			envs: ["needle-env"],
			projects: ["needle-project"],
			statuses: ["FAILED"],
			types: ["DEPLOY"],
			from: "2026-01-01T00:00:00.000Z",
			to: "2026-02-01T00:00:00.000Z",
		};

		it("the rows pass and the matched count carry the filters; the facet pass carries none of them", async () => {
			const filtered = mockDb([[], [], []]);
			await readJobsPage(FILTERS);
			const [rows, matched, facets] = filtered.wheres.map(rendered);
			const needles = ["%needle-search%", "needle-author", "needle-env", "needle-project", "FAILED", "DEPLOY"];
			// The control: without it, a reader that ignored its query would pass the line below.
			for (const pass of [rows, matched]) {
				expect(needles.filter((needle) => !pass?.params.includes(needle))).toEqual([]);
			}
			expect(needles.filter((needle) => facets?.params.includes(needle))).toEqual([]);
			// And it is the SAME predicate as with no filters at all: nothing the query supplied
			// narrowed it, a date bound or an enum rendered without a string parameter included.
			const pristine = mockDb([[], [], []]);
			await readJobsPage({});
			expect(facets).toEqual(rendered(pristine.wheres[2]));
		});

		it("the matched count is filtered exactly as the rows are", async () => {
			const { wheres } = mockDb([[], [], []]);
			await readJobsPage(FILTERS);
			expect(rendered(wheres[1])).toEqual(rendered(wheres[0]));
		});
	});

	describe("a project's list is scoped to the project in every pass", () => {
		it("rows, matched count and facets all carry the project", async () => {
			const { wheres } = mockDb([[], [], []]);
			await readJobsPage({ projectId: "proj-scope" });
			expect(wheres).toHaveLength(3);
			expect(wheres.map(rendered).filter((pass) => !pass.params.includes("proj-scope"))).toEqual([]);
		});

		it("the facet pass narrows with the scope: it is not the org-wide predicate", async () => {
			const scoped = mockDb([[], [], []]);
			await readJobsPage({ projectId: "proj-scope" });
			const org = mockDb([[], [], []]);
			await readJobsPage({});
			expect(rendered(scoped.wheres[2])).not.toEqual(rendered(org.wheres[2]));
			expect(rendered(org.wheres[2]).params).not.toContain("proj-scope");
		});

		it("the scope is not one of the filters: filters change the rows pass and leave the scoped facet pass alone", async () => {
			const bare = mockDb([[], [], []]);
			await readJobsPage({ projectId: "proj-scope" });
			const filtered = mockDb([[], [], []]);
			await readJobsPage({ projectId: "proj-scope", statuses: ["FAILED"], search: "needle" });
			expect(rendered(filtered.wheres[2])).toEqual(rendered(bare.wheres[2]));
			expect(rendered(filtered.wheres[0])).not.toEqual(rendered(bare.wheres[0]));
		});
	});

	describe("the rows are a bounded window", () => {
		it.each([
			["no limit asked", undefined, 50],
			["a larger window", 150, 150],
			["more than the cap", 5_000, 500],
			["a limit that is not a count", Number.NaN, 50],
			["zero", 0, 50],
		])("%s reads %s → LIMIT %s", async (_name, limit, expected) => {
			const { limits } = mockDb([[], [], []]);
			await readJobsPage({ limit });
			expect(limits).toEqual([expected]);
		});
	});
});

// Keeps the job-snapshot filter (lib/jobs/redact-snapshot.ts) on the relocated readers: a deny-listed
// key never leaves, whatever the row holds.
describe("job snapshot redaction on the relocated readers", () => {
	const SENTINEL = "SENTINEL-relocated-reader-6121";
	const snapshot = () => ({ runner_id: "r-1", runner_token: SENTINEL, nested: { password: SENTINEL, region: "eu" } });
	const REDACTED = { runner_id: "r-1", nested: { region: "eu" } };

	it("readJobsPage", async () => {
		mockDb([[{ job: { id: "j-1", config_snapshot: snapshot() }, project_name: null }], [{ matched: 1 }], []]);
		const page = await readJobsPage({});
		expect(page.rows[0]?.config_snapshot).toEqual(REDACTED);
		expect(JSON.stringify(page)).not.toContain(SENTINEL);
	});

	it("readJob", async () => {
		mockDb([[{ job: { id: "job-1", config_snapshot: snapshot() }, project_name: null, project_slug: null, environment_name: null }]]);
		const job = await readJob("job-1");
		expect(job?.config_snapshot).toEqual(REDACTED);
		expect(JSON.stringify(job)).not.toContain(SENTINEL);
	});

	it("readProjectJobs", async () => {
		mockDb([[{ id: "j-1", config_snapshot: snapshot() }]]);
		const rows = await readProjectJobs("proj-1");
		expect(rows[0]?.config_snapshot).toEqual(REDACTED);
		expect(JSON.stringify(rows)).not.toContain(SENTINEL);
	});
});
