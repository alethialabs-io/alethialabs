// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// The runner applying a reviewed plan may read that plan (AGT-S0b, point 3 of #6780): the plan job's
// status and configuration hash (GET /api/jobs/[id]) and its plan file (GET .../plan-artifact), even
// when another runner made the plan. Only the runner holding an in-flight DEPLOY that names the plan,
// only that plan, and only reads. Mocked boundary: runner-token auth, the database and storage; the
// read rule (`verifyRunnerMayReadJob`) and both routes are real.

import { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const verifyRunnerToken = vi.fn();
vi.mock("@/lib/runners/auth", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/runners/auth")>()),
	verifyRunnerToken: (req: Request) => verifyRunnerToken(req),
}));
vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));
const storageGet = vi.fn();
vi.mock("@/lib/storage", () => ({ storage: { get: (...a: unknown[]) => storageGet(...a), put: vi.fn() } }));

import { getServiceDb } from "@/lib/db";
import { verifyRunnerMayReadJob } from "@/lib/runners/auth";

const RUNNER = "runner-apply";
const PLAN = "11111111-1111-4111-8111-111111111111";

/** What each successive SELECT answers, and the WHERE each was built with. */
const db = vi.hoisted(() => ({ answers: [] as unknown[][], wheres: [] as unknown[] }));

/** A drizzle-ish chain: each `.limit()` resolves the next queued answer. */
function mockDb(...answers: unknown[][]) {
	db.answers = answers;
	db.wheres = [];
	const chain: Record<string, unknown> = {};
	Object.assign(chain, {
		select: () => chain,
		from: () => chain,
		where: (w: unknown) => {
			db.wheres.push(w);
			return chain;
		},
		limit: () => Promise.resolve(db.answers.shift() ?? []),
	});
	vi.mocked(getServiceDb).mockReturnValue(chain as never);
}

/** The parameters a recorded WHERE binds, rendered by a real PgDialect. */
function paramsOf(where: unknown): unknown[] {
	if (!(where instanceof SQL)) throw new Error("the recorded WHERE is not a SQL condition");
	return new PgDialect().sqlToQuery(where).params;
}

beforeEach(() => {
	vi.clearAllMocks();
	verifyRunnerToken.mockResolvedValue({ runnerId: RUNNER, tokenHash: "h", operator: "managed", error: null });
});

describe("verifyRunnerMayReadJob", () => {
	it("admits the runner that owns the job", async () => {
		mockDb([{ runner_id: RUNNER, job_type: "DEPLOY", org_id: "org-1" }]);
		await expect(verifyRunnerMayReadJob(RUNNER, PLAN)).resolves.toEqual({ error: null, access: "owner" });
	});

	it("admits the runner whose in-flight DEPLOY or DESTROY of the same org names this plan, asking exactly that", async () => {
		mockDb([{ runner_id: "runner-plan", job_type: "PLAN", org_id: "org-1" }], [{ id: "deploy-1" }]);

		await expect(verifyRunnerMayReadJob(RUNNER, PLAN)).resolves.toEqual({ error: null, access: "applies_plan" });

		// A DESTROY bound to a destroy plan downloads that plan the same way (#7455). Which kind of plan
		// each may apply is checked by the runner and at insert, not here.
		const params = paramsOf(db.wheres[1]);
		expect(params).toEqual(expect.arrayContaining([PLAN, RUNNER, "org-1", "DEPLOY", "DESTROY", "CLAIMED", "PROCESSING"]));
	});

	it("refuses a plan no in-flight DEPLOY of this runner names", async () => {
		mockDb([{ runner_id: "runner-plan", job_type: "PLAN", org_id: "org-1" }], []);
		const res = await verifyRunnerMayReadJob(RUNNER, PLAN);
		expect(res.error?.status).toBe(403);
	});

	it("refuses another runner's job that is not a plan, without looking for a DEPLOY", async () => {
		mockDb([{ runner_id: "runner-other", job_type: "DEPLOY", org_id: "org-1" }], [{ id: "unused" }]);
		const res = await verifyRunnerMayReadJob(RUNNER, PLAN);
		expect(res.error?.status).toBe(403);
		expect(db.wheres).toHaveLength(1);
	});

	it("refuses a plan with no org, and answers 404 for a missing job", async () => {
		mockDb([{ runner_id: "runner-plan", job_type: "PLAN", org_id: null }], [{ id: "unused" }]);
		expect((await verifyRunnerMayReadJob(RUNNER, PLAN)).error?.status).toBe(403);
		mockDb([]);
		expect((await verifyRunnerMayReadJob(RUNNER, PLAN)).error?.status).toBe(404);
	});
});

describe("GET /api/jobs/[id] for the runner applying the plan", () => {
	/** Calls the route as RUNNER. */
	async function get() {
		const { GET } = await import("@/app/api/jobs/[id]/route");
		return GET(new Request(`https://console.local/api/jobs/${PLAN}`), { params: Promise.resolve({ id: PLAN }) });
	}

	it("returns the plan's outcome fields and not its snapshot or metadata", async () => {
		const narrowed = {
			id: PLAN,
			job_type: "PLAN",
			status: "SUCCESS",
			project_id: "p1",
			environment_id: "e1",
			configuration_hash: "c".repeat(64),
			plan_sha256: "d".repeat(64),
			destroy_plan: false,
		};
		mockDb([{ runner_id: "runner-plan", job_type: "PLAN", org_id: "org-1" }], [{ id: "deploy-1" }], [narrowed]);

		const res = await get();

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toEqual(narrowed);
		expect(body).not.toHaveProperty("config_snapshot");
		expect(body).not.toHaveProperty("execution_metadata");
	});

	it("403s a runner with no in-flight DEPLOY of the plan", async () => {
		mockDb([{ runner_id: "runner-plan", job_type: "PLAN", org_id: "org-1" }], []);
		expect((await get()).status).toBe(403);
	});

	it("propagates the 401 from runner auth", async () => {
		verifyRunnerToken.mockResolvedValue({
			runnerId: "",
			tokenHash: "",
			operator: "",
			error: NextResponse.json({ error: "unauth" }, { status: 401 }),
		});
		expect((await get()).status).toBe(401);
	});
});

describe("plan-artifact route for the runner applying the plan", () => {
	/** Calls the route's `method` as RUNNER. */
	async function call(method: "GET" | "POST") {
		const route = await import("@/app/api/jobs/[id]/plan-artifact/route");
		const req = new Request(`https://console.local/api/jobs/${PLAN}/plan-artifact`, {
			method,
			...(method === "POST" ? { body: new Uint8Array([1, 2, 3]) } : {}),
		});
		return route[method](req, { params: Promise.resolve({ id: PLAN }) });
	}

	it("serves the plan file to the runner whose in-flight DEPLOY names the plan", async () => {
		mockDb([{ runner_id: "runner-plan", job_type: "PLAN", org_id: "org-1" }], [{ id: "deploy-1" }]);
		storageGet.mockResolvedValue(new Uint8Array([7, 7, 7]));

		const res = await call("GET");

		expect(res.status).toBe(200);
		expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([7, 7, 7]));
	});

	it("refuses the plan file to a runner with no in-flight DEPLOY of the plan", async () => {
		mockDb([{ runner_id: "runner-plan", job_type: "PLAN", org_id: "org-1" }], []);
		expect((await call("GET")).status).toBe(403);
		expect(storageGet).not.toHaveBeenCalled();
	});

	it("never lets the applying runner WRITE the plan file: upload stays the owner's", async () => {
		mockDb([{ runner_id: "runner-plan" }]);
		expect((await call("POST")).status).toBe(403);
	});
});
