// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Mocked-boundary tests for the jobs actions: stub the authz guard, the usage guard, the scaler,
// and a thenable drizzle chain run via withScope (each await pulls the next seeded result set).
// The reads moved to lib/rpc/procedures/jobs.ts (#6121, tests/lib/rpc/jobs-procedures.test.ts);
// what is pinned here: the shell's unfiltered list, and the writes through the mutation contract —
// every outcome an `ActionResult`, a refusal its own sentence, the rerun payload (its environment
// included) and the cancel state machine.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/authz/guard", () => ({ authorize: vi.fn() }));
vi.mock("@/lib/db", () => ({ withScope: vi.fn() }));
vi.mock("@/lib/billing/usage-guard", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/billing/usage-guard")>()),
	assertUsageAllowed: vi.fn(),
}));
vi.mock("@/lib/billing/job-quota", () => ({ assertJobQuotaAllowed: vi.fn() }));
vi.mock("@/lib/scaler", () => ({ notifyScaler: vi.fn() }));
vi.mock("@/lib/jobs/visibility", async () => {
	const { sql } = await import("drizzle-orm");
	const visible = sql.raw("job_visible_to_reader");
	return { jobVisibleTo: vi.fn(async () => visible) };
});
vi.mock("@/lib/rpc/procedures/jobs", () => ({ readJob: vi.fn() }));
vi.mock("@/lib/jobs/cancel", () => ({ cancelJobAs: vi.fn() }));
vi.mock("@/app/server/actions/projects", () => ({
	tryPlanProject: vi.fn(),
	tryProvisionProject: vi.fn(),
	tryDestroyProject: vi.fn(),
}));

import { applyPlan, cancelJob, getJobs, rerunJob } from "@/app/server/actions/jobs";
import { tryDestroyProject, tryPlanProject, tryProvisionProject } from "@/app/server/actions/projects";
import { authorize } from "@/lib/authz/guard";
import { ForbiddenError } from "@/lib/authz/types";
import { assertUsageAllowed, UsageLimitError } from "@/lib/billing/usage-guard";
import { withScope } from "@/lib/db";
import { jobVisibleTo } from "@/lib/jobs/visibility";
import { cancelJobAs } from "@/lib/jobs/cancel";
import { readJob } from "@/lib/rpc/procedures/jobs";
import { notifyScaler } from "@/lib/scaler";

const JOB = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

/**
 * A drizzle-ish chain whose every builder returns itself; each `await` (then) shifts the next
 * seeded result set. Records `.set()`/`.values()`/`.where()` writes for assertions.
 */
function mockDb(resultSets: unknown[][]) {
	const setSpy = vi.fn();
	const valuesSpy = vi.fn();
	const whereSpy = vi.fn();
	let i = 0;
	const db: Record<string, unknown> = {};
	Object.assign(db, {
		select: () => db,
		from: () => db,
		leftJoin: () => db,
		innerJoin: () => db,
		where: (...a: unknown[]) => {
			whereSpy(...a);
			return db;
		},
		limit: () => db,
		orderBy: () => db,
		insert: () => db,
		values: (...a: unknown[]) => {
			valuesSpy(...a);
			return db;
		},
		returning: () => db,
		update: () => db,
		set: (...a: unknown[]) => {
			setSpy(...a);
			return db;
		},
		then: (resolve: (v: unknown) => void) => {
			const r = i < resultSets.length ? resultSets[i] : (resultSets.at(-1) ?? []);
			i++;
			return resolve(r);
		},
	});
	// withScope({ownerId, orgId}, cb) → invoke cb with our chain.
	vi.mocked(withScope).mockImplementation(
		((_scope: unknown, cb: (tx: unknown) => unknown) => cb(db)) as never,
	);
	return { setSpy, valuesSpy, whereSpy };
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(authorize).mockResolvedValue({ userId: "user-1", orgId: "org-1" } as never);
});

describe("getJobs", () => {
	it("flattens joined rows and falls back to null for missing joins", async () => {
		mockDb([
			[
				{
					job: { id: "j-1", status: "DONE" },
					project_name: "Web",
					project_slug: "web",
					runner_name: "runner-a",
					cloud_provider: "aws",
				},
				{
					job: { id: "j-2", status: "QUEUED" },
					project_name: null,
					project_slug: null,
					runner_name: null,
					cloud_provider: null,
				},
			],
		]);
		const rows = await getJobs();
		expect(authorize).toHaveBeenCalledWith("view", { type: "job" });
		expect(rows[0]).toMatchObject({
			id: "j-1",
			status: "DONE",
			project_name: "Web",
			project_slug: "web",
			runner_name: "runner-a",
			cloud_provider: "aws",
		});
		expect(rows[1]).toMatchObject({ id: "j-2", project_name: null, runner_name: null, cloud_provider: null });
	});

	it("lists only the jobs visible to the reader (job visibility follows project visibility)", async () => {
		const { whereSpy } = mockDb([[]]);
		await getJobs();
		expect(jobVisibleTo).toHaveBeenCalledWith({ userId: "user-1", orgId: "org-1" });
		expect(whereSpy).toHaveBeenCalledTimes(1);
		expect(String(whereSpy.mock.calls[0]?.[0]?.queryChunks?.[0]?.value)).toContain("job_visible_to_reader");
	});
});

describe("rerunJob — a project's operation runs again through its own entry point", () => {
	const projectJob = (job_type: string, extra: Record<string, unknown> = {}) => ({
		job_type,
		config_snapshot: { stale: true },
		cloud_identity_id: "ci-1",
		project_id: "proj-1",
		environment_id: "env-1",
		org_id: "org-1",
		project_org_id: "org-1",
		...extra,
	});

	it.each([
		["PLAN", () => tryPlanProject, ["proj-1", null, "env-1"]],
		["DEPLOY", () => tryProvisionProject, ["proj-1", undefined, null, "env-1"]],
		["DESTROY", () => tryDestroyProject, ["proj-1", "env-1", null]],
	] as const)("re-runs a %s through the entry point a fresh run uses, with its project and environment", async (type, entry, args) => {
		const { valuesSpy } = mockDb([[projectJob(type)]]);
		vi.mocked(entry()).mockResolvedValue({ ok: true, jobId: "new-job" } as never);
		expect(await rerunJob({ jobId: JOB })).toEqual({ ok: true, data: { id: "new-job" } });
		expect(entry()).toHaveBeenCalledWith(...args);
		// Nothing is copied: the entry point builds the job from the project's current configuration.
		expect(valuesSpy).not.toHaveBeenCalled();
		// Its permission is the operation's on the project (inside the entry point), not `create` on job.
		expect(authorize).toHaveBeenCalledWith("view", { type: "job", id: JOB });
		expect(authorize).not.toHaveBeenCalledWith("create", { type: "job" });
	});

	it("returns the entry point's refusal (a job already in flight, a gate) as its own sentence", async () => {
		mockDb([[projectJob("DEPLOY")]]);
		vi.mocked(tryProvisionProject).mockResolvedValue({ ok: false, error: "A job is already running on this environment." } as never);
		expect(await rerunJob({ jobId: JOB })).toEqual({
			ok: false,
			error: { kind: "conflict", message: "A job is already running on this environment." },
		});
	});

	it("refuses a project job the entry points do not express, saying where to run it again", async () => {
		mockDb([[projectJob("DETECT_DRIFT")]]);
		expect(await rerunJob({ jobId: JOB })).toEqual({
			ok: false,
			error: { kind: "conflict", message: "This job can't be re-run from here. Run it again from the project." },
		});
		expect(tryProvisionProject).not.toHaveBeenCalled();
	});

	it("re-queues an allow-listed org-level job (an AUDIT) as a copy, under the org's job permission and the usage gate", async () => {
		const { valuesSpy } = mockDb([
			[{ job_type: "AUDIT", config_snapshot: { scope: 1 }, cloud_identity_id: null, project_id: null, environment_id: null, org_id: "org-1", project_org_id: null }],
			[{ id: "new-job" }],
		]);
		expect(await rerunJob({ jobId: JOB })).toEqual({ ok: true, data: { id: "new-job" } });
		expect(authorize).toHaveBeenCalledWith("create", { type: "job" });
		expect(assertUsageAllowed).toHaveBeenCalledWith("org-1");
		expect(valuesSpy).toHaveBeenCalledWith(
			expect.objectContaining({ job_type: "AUDIT", config_snapshot: { scope: 1 }, status: "QUEUED", org_id: "org-1" }),
		);
		expect(notifyScaler).toHaveBeenCalledTimes(1);
	});

	it("refuses a runner's lifecycle job — it is run again from the runner — and copies nothing", async () => {
		const { valuesSpy } = mockDb([
			[{ job_type: "UPDATE_RUNNER", config_snapshot: { runner_id: "r-1" }, project_id: null, environment_id: null, org_id: "org-1", project_org_id: null }],
		]);
		expect(await rerunJob({ jobId: JOB })).toEqual({
			ok: false,
			error: { kind: "conflict", message: "This job can't be re-run from here. Run it again from the runner." },
		});
		expect(valuesSpy).not.toHaveBeenCalled();
	});

	it("refuses a job the reader cannot see as not found", async () => {
		mockDb([[]]);
		expect(await rerunJob({ jobId: OTHER })).toEqual({
			ok: false,
			error: { kind: "not-found", message: "Job not found." },
		});
		expect(tryProvisionProject).not.toHaveBeenCalled();
	});

	it("refuses a job of another organization with a sentence the user can act on", async () => {
		mockDb([[{ ...projectJob("PLAN"), project_id: null, environment_id: null, org_id: "user-1" }]]);
		expect(await rerunJob({ jobId: JOB })).toEqual({
			ok: false,
			error: { kind: "conflict", message: "This job belongs to your personal workspace — switch to it to run this." },
		});
	});

	it("refuses when the job's project is not in the active org", async () => {
		mockDb([[projectJob("PLAN", { project_org_id: "org-b" })]]);
		expect(await rerunJob({ jobId: JOB })).toEqual({
			ok: false,
			error: { kind: "conflict", message: "This project belongs to another organization — switch to it to run this." },
		});
		expect(tryPlanProject).not.toHaveBeenCalled();
	});

	it("returns the usage cap on a copy as a plan-gate refusal in its own words", async () => {
		mockDb([[{ job_type: "AUDIT", project_id: null, environment_id: null, org_id: "org-1", project_org_id: null }]]);
		vi.mocked(assertUsageAllowed).mockRejectedValueOnce(new UsageLimitError("Usage cap reached (100 minutes).", false));
		expect(await rerunJob({ jobId: JOB })).toEqual({
			ok: false,
			error: { kind: "entitlement", message: "Usage cap reached (100 minutes).", feature: "usage" },
		});
	});

	it("rejects an id that cannot be a job before doing anything", async () => {
		const result = await rerunJob({ jobId: "not-a-job" });
		expect(result).toMatchObject({ ok: false, error: { kind: "validation" } });
		expect(authorize).not.toHaveBeenCalled();
	});
});

describe("cancelJob — the shared cancel, mapped to the mutation contract", () => {
	it("cancels through the shared implementation as the actor, scoped by job visibility", async () => {
		vi.mocked(cancelJobAs).mockResolvedValue({ kind: "cancelled", signalled: true });
		mockDb([]);
		expect(await cancelJob({ jobId: JOB })).toEqual({ ok: true, data: null });
		expect(authorize).toHaveBeenCalledWith("edit", { type: "job", id: JOB });
		expect(cancelJobAs).toHaveBeenCalledWith({ userId: "user-1", orgId: "org-1" }, JOB, expect.anything(), expect.any(Function));
	});

	it.each([
		[{ kind: "not-found" }, { kind: "not-found", message: "Job not found." }],
		[{ kind: "not-cancellable", status: "SUCCESS" }, { kind: "conflict", message: "This job is success — only a queued or running job can be cancelled." }],
		[{ kind: "no-target" }, { kind: "not-found", message: "This job's runner or project no longer exists, so it can't be cancelled here." }],
	] as const)("maps %o to a refusal the user can read", async (outcome, error) => {
		vi.mocked(cancelJobAs).mockResolvedValue(outcome);
		mockDb([]);
		expect(await cancelJob({ jobId: JOB })).toEqual({ ok: false, error });
	});

	it("a refused target permission is a forbidden result", async () => {
		vi.mocked(cancelJobAs).mockRejectedValue(new ForbiddenError("deploy", { type: "project", id: "proj-1" }));
		mockDb([]);
		expect(await cancelJob({ jobId: JOB })).toMatchObject({ ok: false, error: { kind: "forbidden" } });
	});
});

describe("applyPlan", () => {
	const PLAN = {
		id: JOB,
		job_type: "PLAN",
		status: "SUCCESS",
		project_id: "proj-1",
		environment_id: "env-staging",
	};

	it("deploys the plan against the project AND THE ENVIRONMENT the plan ran for, read on the server", async () => {
		vi.mocked(readJob).mockResolvedValue(PLAN as never);
		vi.mocked(tryProvisionProject).mockResolvedValue({ ok: true, jobId: "deploy-1", jobType: "DEPLOY" } as never);
		expect(await applyPlan({ planJobId: JOB, runnerId: null })).toEqual({ ok: true, data: { jobId: "deploy-1" } });
		expect(readJob).toHaveBeenCalledWith(JOB);
		expect(tryProvisionProject).toHaveBeenCalledWith("proj-1", JOB, null, "env-staging");
	});

	it("returns the provisioner's refusal as its own sentence", async () => {
		vi.mocked(readJob).mockResolvedValue(PLAN as never);
		vi.mocked(tryProvisionProject).mockResolvedValue({ ok: false, error: "Connect a cloud account first." } as never);
		expect(await applyPlan({ planJobId: JOB, runnerId: "runner-1" })).toEqual({
			ok: false,
			error: { kind: "conflict", message: "Connect a cloud account first." },
		});
	});

	it("refuses a plan the reader cannot see, and anything that is not a successful plan", async () => {
		vi.mocked(readJob).mockResolvedValueOnce(null);
		expect(await applyPlan({ planJobId: JOB, runnerId: null })).toMatchObject({ ok: false, error: { kind: "not-found" } });
		vi.mocked(readJob).mockResolvedValueOnce({ ...PLAN, status: "FAILED" } as never);
		expect(await applyPlan({ planJobId: JOB, runnerId: null })).toMatchObject({ ok: false, error: { kind: "conflict" } });
		expect(tryProvisionProject).not.toHaveBeenCalled();
	});
});

// Keeps the job-snapshot filter (lib/jobs/redact-snapshot.ts) on the reads and the copy that stay here.
describe("job snapshot redaction", () => {
	const SENTINEL = "SENTINEL-read-redaction-6121";
	const snapshot = () => ({ runner_id: "r-1", runner_token: SENTINEL, nested: { password: SENTINEL, region: "eu" } });

	it("getJobs", async () => {
		mockDb([[{ job: { id: "j-1", config_snapshot: snapshot() }, project_name: null }]]);
		const rows = await getJobs();
		expect(rows[0]?.config_snapshot).toEqual({ runner_id: "r-1", nested: { region: "eu" } });
		expect(JSON.stringify(rows)).not.toContain(SENTINEL);
	});

	it("a re-run's copy carries no runner token (a copy is issued its own)", async () => {
		const { valuesSpy } = mockDb([
			[{ job_type: "AUDIT", config_snapshot: { audit: "x", runner_token: SENTINEL }, cloud_identity_id: null, project_id: null, environment_id: null, org_id: "org-1", project_org_id: null }],
			[{ id: "new-job" }],
		]);
		expect(await rerunJob({ jobId: JOB })).toEqual({ ok: true, data: { id: "new-job" } });
		expect(valuesSpy).toHaveBeenCalledWith(expect.objectContaining({ config_snapshot: { audit: "x" } }));
		expect(JSON.stringify(valuesSpy.mock.calls)).not.toContain(SENTINEL);
	});
});
