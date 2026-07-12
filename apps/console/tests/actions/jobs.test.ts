// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Mocked-boundary tests for the jobs actions: stub the authz guard, the usage guard, the scaler,
// and a thenable drizzle chain run via withOwnerScope (each await pulls the next seeded result set).
// We assert the read shapes + join-null fallbacks, the rerun insert payload + scaler notify, and the
// cancel state machine (cancellable vs terminal statuses) and not-found throws.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/authz/guard", () => ({ authorize: vi.fn() }));
vi.mock("@/lib/db", () => ({ withOwnerScope: vi.fn() }));
vi.mock("@/lib/billing/usage-guard", () => ({ assertUsageAllowed: vi.fn() }));
vi.mock("@/lib/scaler", () => ({ notifyScaler: vi.fn() }));
vi.mock("@/lib/runners/cancel-signal", () => ({
	notifyRunnerCancel: vi.fn().mockResolvedValue(undefined),
}));

import {
	cancelJob,
	getJob,
	getJobs,
	getJobStatus,
	getPlanResult,
	getProjectJobs,
	rerunJob,
} from "@/app/server/actions/jobs";
import { authorize } from "@/lib/authz/guard";
import { assertUsageAllowed } from "@/lib/billing/usage-guard";
import { withOwnerScope } from "@/lib/db";
import { notifyRunnerCancel } from "@/lib/runners/cancel-signal";
import { notifyScaler } from "@/lib/scaler";

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
	// withOwnerScope(owner, cb) → invoke cb with our chain.
	vi.mocked(withOwnerScope).mockImplementation(
		((_owner: unknown, cb: (tx: unknown) => unknown) => cb(db)) as never,
	);
	return { setSpy, valuesSpy, whereSpy };
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(authorize).mockResolvedValue({ userId: "user-1", orgId: "org-1" } as never);
});

describe("getJobStatus", () => {
	it("returns the seeded status row", async () => {
		mockDb([[{ status: "PROCESSING", error_message: null }]]);
		expect(await getJobStatus("job-1")).toEqual({ status: "PROCESSING", error_message: null });
		expect(authorize).toHaveBeenCalledWith("view", { type: "job", id: "job-1" });
	});

	it("throws when the job is missing", async () => {
		mockDb([[]]);
		await expect(getJobStatus("job-x")).rejects.toThrow(/Failed to get job status/);
	});

	it("propagates an authorization failure (unauthorized)", async () => {
		vi.mocked(authorize).mockRejectedValueOnce(new Error("Forbidden"));
		await expect(getJobStatus("job-1")).rejects.toThrow(/Forbidden/);
		expect(withOwnerScope).not.toHaveBeenCalled();
	});
});

describe("getJob", () => {
	it("returns the row when found", async () => {
		mockDb([[{ id: "job-1", status: "QUEUED" }]]);
		expect(await getJob("job-1")).toMatchObject({ id: "job-1" });
	});

	it("returns null when no row exists", async () => {
		mockDb([[]]);
		expect(await getJob("job-x")).toBeNull();
	});
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
		expect(rows[1]).toMatchObject({
			id: "j-2",
			project_name: null,
			runner_name: null,
			cloud_provider: null,
		});
	});
});

describe("getPlanResult", () => {
	it("returns status + execution metadata", async () => {
		mockDb([
			[{ status: "DONE", error_message: null, execution_metadata: { plan: "ok" } }],
		]);
		expect(await getPlanResult("job-1")).toMatchObject({
			status: "DONE",
			execution_metadata: { plan: "ok" },
		});
	});

	it("throws when the job is missing", async () => {
		mockDb([[]]);
		await expect(getPlanResult("job-x")).rejects.toThrow(/Failed to get plan result/);
	});
});

describe("getProjectJobs", () => {
	it("authorizes the project and returns its jobs", async () => {
		mockDb([[{ id: "j-1" }, { id: "j-2" }]]);
		const rows = await getProjectJobs("proj-1");
		expect(authorize).toHaveBeenCalledWith("view", { type: "project", id: "proj-1" });
		expect(rows).toHaveLength(2);
	});
});

describe("rerunJob", () => {
	it("clones the original into a QUEUED job, checks usage, and notifies the scaler", async () => {
		const { valuesSpy } = mockDb([
			[
				{
					job_type: "PLAN",
					config_snapshot: { foo: "bar" },
					cloud_identity_id: "ci-1",
					project_id: "proj-1",
				},
			],
			[{ id: "new-job" }],
		]);
		const result = await rerunJob("job-1");

		expect(authorize).toHaveBeenCalledWith("create", { type: "job" });
		expect(assertUsageAllowed).toHaveBeenCalledWith("org-1");
		expect(valuesSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				user_id: "user-1",
				job_type: "PLAN",
				config_snapshot: { foo: "bar" },
				cloud_identity_id: "ci-1",
				project_id: "proj-1",
				status: "QUEUED",
			}),
		);
		expect(notifyScaler).toHaveBeenCalledTimes(1);
		expect(result).toEqual({ id: "new-job" });
	});

	it("throws when the original job is not found (no insert, no notify)", async () => {
		const { valuesSpy } = mockDb([[]]);
		await expect(rerunJob("job-x")).rejects.toThrow(/Original job not found/);
		expect(valuesSpy).not.toHaveBeenCalled();
		expect(notifyScaler).not.toHaveBeenCalled();
	});

	it("propagates a usage-guard rejection before touching the db", async () => {
		mockDb([[{ job_type: "PLAN" }]]);
		vi.mocked(assertUsageAllowed).mockRejectedValueOnce(new Error("Usage limit reached"));
		await expect(rerunJob("job-1")).rejects.toThrow(/Usage limit reached/);
		expect(withOwnerScope).not.toHaveBeenCalled();
	});
});

describe("cancelJob", () => {
	it("cancels a QUEUED job DB-only (no runner to signal)", async () => {
		const { setSpy } = mockDb([[{ status: "QUEUED", runner_id: null }], []]);
		await cancelJob("job-1");
		expect(authorize).toHaveBeenCalledWith("edit", { type: "job", id: "job-1" });
		expect(setSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				status: "CANCELLED",
				error_message: "Cancelled by user",
				completed_at: expect.any(Date),
			}),
		);
		// A QUEUED job has no assigned runner → no mid-flight signal.
		expect(notifyRunnerCancel).not.toHaveBeenCalled();
	});

	it("signals the owning runner for a PROCESSING job (not just a DB flip)", async () => {
		const { setSpy } = mockDb([
			[{ status: "PROCESSING", runner_id: "runner-7" }],
			[],
		]);
		await cancelJob("job-run");
		expect(setSpy).toHaveBeenCalledWith(
			expect.objectContaining({ status: "CANCELLED" }),
		);
		expect(notifyRunnerCancel).toHaveBeenCalledWith("runner-7", "job-run");
	});

	it("signals the owning runner for a CLAIMED job", async () => {
		mockDb([[{ status: "CLAIMED", runner_id: "runner-9" }], []]);
		await cancelJob("job-claimed");
		expect(notifyRunnerCancel).toHaveBeenCalledWith("runner-9", "job-claimed");
	});

	it("throws when the job is missing (no write, no signal)", async () => {
		const { setSpy } = mockDb([[]]);
		await expect(cancelJob("job-x")).rejects.toThrow(/Job not found/);
		expect(setSpy).not.toHaveBeenCalled();
		expect(notifyRunnerCancel).not.toHaveBeenCalled();
	});

	it("refuses to cancel a job in a terminal status", async () => {
		const { setSpy } = mockDb([[{ status: "DONE", runner_id: null }]]);
		await expect(cancelJob("job-1")).rejects.toThrow(/Cannot cancel job with status DONE/);
		expect(setSpy).not.toHaveBeenCalled();
		expect(notifyRunnerCancel).not.toHaveBeenCalled();
	});
});
