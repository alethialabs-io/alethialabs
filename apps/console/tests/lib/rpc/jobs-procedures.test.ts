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
	readJobLogsHead,
	readJobStatus,
	readJobsPage,
	readPlanResult,
	readProjectJobs,
} from "@/lib/rpc/procedures/jobs";

const ACTOR = { userId: "user-1", orgId: "org-1" };
const dialect = new PgDialect();

/** A drizzle-ish chain; each `await` resolves the next seeded result set. Records `.where()` args. */
function mockDb(resultSets: unknown[][]) {
	const wheres: unknown[] = [];
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
		limit: () => db,
		orderBy: () => db,
		then: (resolve: (v: unknown) => void) => resolve(resultSets[i++] ?? []),
	});
	vi.mocked(withScope).mockImplementation(((_scope: unknown, cb: (tx: unknown) => unknown) => cb(db)) as never);
	return { wheres };
}

/** Whether a recorded `.where()` argument carries the visibility predicate. */
function carriesVisibility(where: unknown): boolean {
	return is(where, SQL) && dialect.sqlToQuery(where).sql.includes("job_visible_to_reader");
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(authorize).mockResolvedValue(ACTOR as never);
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
		// Both passes: the rows AND the facet counts, or a hidden project's name leaks as a facet.
		["readJobsPage", () => readJobsPage({}), [[], []], 2],
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
		});
	});

	it("resumes from zero for a job with no log yet", async () => {
		mockDb([[{ id: "job-1" }], []]);
		expect(await readJobLogsHead("job-1")).toEqual({ lines: [], lastId: 0 });
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
	it("flattens the rows and counts facets over the visible universe", async () => {
		mockDb([
			[{ job: { id: "j-1", status: "FAILED" }, project_name: "Web", project_slug: "web", runner_name: null }],
			[
				{ status: "FAILED", job_type: "PLAN", user_id: "u-1", project_id: "p-1", project_name: "Web", environment_id: "e-1", environment_name: "prod", environment_stage: "production" },
				{ status: "SUCCESS", job_type: "PLAN", user_id: "u-1", project_id: null, project_name: null, environment_id: null, environment_name: null, environment_stage: null },
			],
		]);
		const page = await readJobsPage({ statuses: ["FAILED"] });
		expect(page.rows[0]).toMatchObject({ id: "j-1", project_name: "Web", runner_name: null, cloud_provider: null });
		expect(page.total).toBe(2);
		expect(page.facets.projects).toEqual([{ value: "p-1", label: "Web", count: 1 }]);
		expect(page.facets.envs).toEqual([{ value: "e-1", label: "prod (production)", count: 1 }]);
		expect(page.facets.statuses.map((o) => o.value)).toEqual(["FAILED", "SUCCESS"]);
		expect(page.facets.authors).toEqual([{ value: "u-1", label: null, count: 2 }]);
	});
});

// Keeps the job-snapshot filter (lib/jobs/redact-snapshot.ts) on the relocated readers: a deny-listed
// key never leaves, whatever the row holds.
describe("job snapshot redaction on the relocated readers", () => {
	const SENTINEL = "SENTINEL-relocated-reader-6121";
	const snapshot = () => ({ runner_id: "r-1", runner_token: SENTINEL, nested: { password: SENTINEL, region: "eu" } });
	const REDACTED = { runner_id: "r-1", nested: { region: "eu" } };

	it("readJobsPage", async () => {
		mockDb([[{ job: { id: "j-1", config_snapshot: snapshot() }, project_name: null }], []]);
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
