// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Mocked-boundary tests for the approval idempotency key on planProject / provisionProject (#5797).
//
// The database behaviour — the unique index, the conflict arbiter, two concurrent transactions —
// is proven against real Postgres in tests/integration/approval-idempotency.test.ts. This file pins
// the action's own decisions, which a database cannot see: which calls take the keyed path at all,
// that a repeat answers BEFORE the spend gates, that a conflicted insert neither moves the
// environment nor audits, and that a malformed key is a refusal rather than an insert.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** One recorded query: its operation, the table it touched, and the builder calls it made. */
interface Recorded {
	op: "select" | "insert" | "update" | "delete";
	table: unknown;
	values?: unknown;
	onConflict?: unknown;
	/** The WHERE the query was built with, rendered later by a real PgDialect. */
	where?: unknown;
}

const state = vi.hoisted(() => ({
	recorded: [] as Recorded[],
	/** Rows a SELECT on a table answers. */
	select: new Map<unknown, unknown[]>(),
	/** Rows an INSERT … RETURNING answers, per table. */
	insert: new Map<unknown, unknown[]>(),
	executed: 0,
}));

/** A thenable drizzle-ish builder that records what it was asked and answers from `state`. */
function chain(op: Recorded["op"], table?: unknown) {
	const rec: Recorded = { op, table };
	state.recorded.push(rec);
	const c = {
		from(t: unknown) {
			rec.table = t;
			return c;
		},
		leftJoin: () => c,
		innerJoin: () => c,
		where(w: unknown) {
			rec.where = w;
			return c;
		},
		limit: () => c,
		orderBy: () => c,
		groupBy: () => c,
		returning: () => c,
		set: () => c,
		values(v: unknown) {
			rec.values = v;
			return c;
		},
		onConflictDoNothing(cfg: unknown) {
			rec.onConflict = cfg ?? {};
			return c;
		},
		then(res: (rows: unknown[]) => void) {
			const rows =
				op === "select"
					? state.select.get(rec.table)
					: op === "insert"
						? state.insert.get(rec.table)
						: undefined;
			res(rows ?? []);
		},
	};
	return c;
}

const fakeTx = {
	select: () => chain("select"),
	insert: (t: unknown) => chain("insert", t),
	update: (t: unknown) => chain("update", t),
	delete: (t: unknown) => chain("delete", t),
	execute: () => {
		state.executed += 1;
		return Promise.resolve([{ updated: true }]);
	},
};

vi.mock("@/lib/db", () => ({
	withScope: vi.fn((_scope: unknown, fn: (tx: typeof fakeTx) => unknown) => fn(fakeTx)),
	withActorScope: vi.fn((_actor: unknown, fn: (tx: typeof fakeTx) => unknown) => fn(fakeTx)),
	getServiceDb: vi.fn(() => fakeTx),
}));
vi.mock("@/lib/authz/guard", () => ({
	authorize: vi.fn(async () => ({ userId: "user-1", orgId: "org-1" })),
	currentActor: vi.fn(async () => ({ userId: "user-1", orgId: "org-1" })),
}));
vi.mock("@/lib/billing/usage-guard", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/billing/usage-guard")>()),
	assertUsageAllowed: vi.fn(async () => undefined),
}));
vi.mock("@/lib/billing/job-quota", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/billing/job-quota")>()),
	assertJobQuotaAllowed: vi.fn(async () => undefined),
}));
vi.mock("@/lib/scaler", () => ({ notifyScaler: vi.fn() }));
vi.mock("@/lib/auth/owner", () => ({ requireOwner: vi.fn() }));
vi.mock("@/lib/authz/tuple-sync", () => ({ mirrorHierarchyEdge: vi.fn() }));

import {
	getApprovedJob,
	planProject,
	provisionProject,
	tryPlanProject,
} from "@/app/server/actions/projects";
import { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { approvalKeyOf } from "@/components/agent/approval-card";
import { authorize } from "@/lib/authz/guard";
import { assertUsageAllowed } from "@/lib/billing/usage-guard";
import {
	auditLog,
	cloudIdentities,
	jobs,
	projectEnvironments,
	projects,
} from "@/lib/db/schema";

const KEY = "thread-1:toolu_abc";

/** The minimum a config snapshot reads: the project, its default env, and its cloud identity. */
function seedSnapshot() {
	state.select.set(projects, [
		{ id: "p1", org_id: "org-1", cloud_identity_id: "ci-1", region: "us-east-1" },
	]);
	state.select.set(projectEnvironments, [
		{
			id: "env-1",
			name: "production",
			stage: "production",
			status: "ACTIVE",
			is_default: true,
			region: null,
			fabric_id: null,
			placement_mode: "dedicated",
		},
	]);
	state.select.set(cloudIdentities, [{ id: "ci-1", provider: "aws" }]);
}

/** The recorded INSERTs into `jobs`. */
function jobInserts(): Recorded[] {
	return state.recorded.filter((r) => r.op === "insert" && r.table === jobs);
}

/** The `idempotency_key` an insert's values carried, if any. */
function keyOf(r: Recorded | undefined): unknown {
	const v = r?.values;
	return v && typeof v === "object" && "idempotency_key" in v ? v.idempotency_key : undefined;
}

beforeEach(() => {
	state.recorded = [];
	state.select = new Map();
	state.insert = new Map();
	state.executed = 0;
	seedSnapshot();
	vi.clearAllMocks();
});

afterEach(() => {
	vi.mocked(authorize).mockResolvedValue({ userId: "user-1", orgId: "org-1" });
});

describe("planProject — approval key (#5797)", () => {
	it("without a key, inserts exactly as before: no conflict clause, no key column", async () => {
		state.insert.set(jobs, [{ id: "job-new" }]);

		await expect(planProject("p1")).resolves.toEqual({ jobId: "job-new" });

		const [insert] = jobInserts();
		expect(insert.onConflict).toBeUndefined();
		expect(keyOf(insert)).toBeUndefined();
		expect(state.executed).toBe(1);
	});

	it("with a key, stores a SHA-256 digest and inserts against the scoped unique index", async () => {
		state.insert.set(jobs, [{ id: "job-new" }]);

		await expect(planProject("p1", undefined, undefined, KEY)).resolves.toEqual({
			jobId: "job-new",
		});

		const [insert] = jobInserts();
		expect(keyOf(insert)).toMatch(/^[0-9a-f]{64}$/);
		expect(insert.onConflict).toMatchObject({
			target: [jobs.org_id, jobs.project_id, jobs.user_id, jobs.idempotency_key],
		});
		expect(state.executed).toBe(1);
	});

	it("a repeated approval answers the existing job BEFORE the spend gates, and inserts nothing", async () => {
		state.select.set(jobs, [{ id: "job-first", job_type: "PLAN" }]);

		await expect(planProject("p1", undefined, undefined, KEY)).resolves.toEqual({
			jobId: "job-first",
		});

		expect(assertUsageAllowed).not.toHaveBeenCalled();
		expect(jobInserts()).toHaveLength(0);
		expect(state.executed).toBe(0);
	});

	it("a conflicted insert reads the winner back and neither moves the environment nor audits", async () => {
		// The early lookup misses (the concurrent winner had not committed), the insert conflicts.
		let lookups = 0;
		state.select.set(jobs, []);
		const realGet = state.select.get.bind(state.select);
		state.select.get = (t: unknown) => {
			if (t !== jobs) return realGet(t);
			lookups += 1;
			return lookups === 1 ? [] : [{ id: "job-winner", job_type: "DEPLOY" }];
		};
		state.insert.set(jobs, []);

		await expect(
			provisionProject("p1", undefined, undefined, undefined, KEY),
		).resolves.toEqual({ jobId: "job-winner" });

		expect(jobInserts()).toHaveLength(1);
		expect(state.executed).toBe(0);
		expect(state.recorded.filter((r) => r.op === "insert" && r.table === auditLog)).toHaveLength(0);
	});

	it("a plan key and a deploy key of the same text store different digests", async () => {
		state.insert.set(jobs, [{ id: "job-new" }]);
		await planProject("p1", undefined, undefined, KEY);
		await provisionProject("p1", undefined, undefined, undefined, KEY);

		const [plan, deploy] = jobInserts();
		expect(keyOf(plan)).not.toBe(keyOf(deploy));
	});

	it.each([
		["empty", ""],
		["over 512 characters", "x".repeat(513)],
	])("a malformed (%s) key is a refusal, not an insert", async (_label, key) => {
		state.insert.set(jobs, [{ id: "job-new" }]);

		const res = await tryPlanProject("p1", undefined, undefined, key);

		expect(res).toMatchObject({ ok: false });
		expect(jobInserts()).toHaveLength(0);
	});
});

describe("getApprovedJob (#5797)", () => {
	it("authorizes a project read and answers the job the key queued", async () => {
		state.select.set(jobs, [{ id: "job-first", job_type: "PLAN" }]);

		await expect(getApprovedJob("p1", "plan_project", KEY)).resolves.toEqual({
			jobId: "job-first",
		});
		expect(authorize).toHaveBeenCalledWith("view", { type: "project", id: "p1" });
	});

	it("answers null for no match, and for a malformed key without querying", async () => {
		await expect(getApprovedJob("p1", "provision_project", KEY)).resolves.toBeNull();
		state.recorded = [];
		await expect(getApprovedJob("p1", "plan_project", "")).resolves.toBeNull();
		expect(state.recorded).toHaveLength(0);
	});
});

/** The SQL text of every recorded SELECT on `jobs`' WHERE clause, rendered by a real PgDialect. */
function jobLookupWheres(): string[] {
	const dialect = new PgDialect();
	return state.recorded
		.filter((r) => r.op === "select" && r.table === jobs)
		.map((r) => (r.where instanceof SQL ? dialect.sqlToQuery(r.where).sql : ""));
}

// The lookup is the only thing between a client-chosen key and someone else's job: RLS's `owner_all`
// is `user OR org`, so it does not hide the caller's own job in another org, nor a colleague's job in
// this org. These pin each of the four predicates, so dropping any one of them goes red here — fast,
// without the real-Postgres suite.
describe("the existing-job lookup is scoped to org, project, user and key (#5797)", () => {
	it.each([
		["the early lookup", () => planProject("p1", undefined, undefined, KEY)],
		["the card's lookup", () => getApprovedJob("p1", "plan_project", KEY)],
	])("%s filters on every scope column", async (_label, run) => {
		state.insert.set(jobs, [{ id: "job-new" }]);
		await run();

		const [where] = jobLookupWheres();
		expect(where).toBeTruthy();
		for (const col of ["org_id", "project_id", "user_id", "idempotency_key"]) {
			expect(where).toContain(`"jobs"."${col}" = $`);
		}
	});

	it("the conflict read-back filters on every scope column too", async () => {
		state.insert.set(jobs, []);
		let n = 0;
		const realGet = state.select.get.bind(state.select);
		state.select.get = (t: unknown) => {
			if (t !== jobs) return realGet(t);
			n += 1;
			return n === 1 ? [] : [{ id: "job-winner", job_type: "PLAN" }];
		};
		await planProject("p1", undefined, undefined, KEY);

		const wheres = jobLookupWheres();
		expect(wheres).toHaveLength(2);
		for (const col of ["org_id", "project_id", "user_id", "idempotency_key"]) {
			expect(wheres[1]).toContain(`"jobs"."${col}" = $`);
		}
	});
});

describe("approvalKeyOf", () => {
	// The fallback is deliberate, not a gap: a proposal with no thread (an ephemeral conversation)
	// still dedupes, on the tool call id alone — a provider-minted random id, unique per call.
	it("qualifies the tool call by its thread, and falls back to the tool call alone", () => {
		expect(approvalKeyOf("t-1", "toolu_1")).toBe("t-1:toolu_1");
		expect(approvalKeyOf(null, "toolu_1")).toBe("toolu_1");
	});
});
