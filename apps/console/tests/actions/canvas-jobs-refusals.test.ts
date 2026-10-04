// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #5454 — the Run menu's audit and probe refusals are RETURNED, not thrown.
//
// `queueEnvironmentAudit` and `queueClusterProbe` used to THROW "Run a plan first", "never been
// deployed", "already running" and the free daily job quota out of a `"use server"` export. A
// production build replaces a thrown message with a digest, so the menu's toast showed noise where
// the reason belonged. Each case below asserts the refusal RESOLVES as `{ ok: false, error }` with
// the sentence intact; against origin/dev every one of them fails, because the action rejects.
//
// What must still THROW is pinned too: an environment outside the caller's project is not advice
// the person at the menu can act on, and an unexpected error keeps its redaction.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/authz/guard", () => ({
	authorize: vi.fn(async () => ({ orgId: "org-1", userId: "u1" })),
}));
vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn(), withActorScope: vi.fn() }));
vi.mock("@/lib/billing/job-quota", () => ({ assertJobQuotaAllowed: vi.fn() }));
vi.mock("@/lib/db/signed-job", () => ({ signedJob: vi.fn((v: unknown) => v) }));
vi.mock("@/lib/scaler", () => ({ notifyScaler: vi.fn() }));

import {
	queueClusterProbe,
	queueEnvironmentAudit,
} from "@/app/server/actions/canvas-jobs";
import { assertJobQuotaAllowed } from "@/lib/billing/job-quota";
import { UsageLimitError } from "@/lib/billing/usage-guard";
import { getServiceDb, withActorScope } from "@/lib/db";

/**
 * A drizzle-ish service db whose Nth `select()` chain resolves to `results[N]`. The actions run
 * their reads in a fixed order — env-in-org guard, then the source job, then the in-flight check —
 * so the queue is the scenario.
 */
function mockReads(results: unknown[][]) {
	let n = 0;
	const chain = () => {
		const own = results[n++] ?? [];
		const db: Record<string, unknown> = {};
		Object.assign(db, {
			from: () => db,
			innerJoin: () => db,
			where: () => db,
			orderBy: () => db,
			limit: () => db,
			then: (resolve: (v: unknown) => void) => resolve(own),
		});
		return db;
	};
	vi.mocked(getServiceDb).mockReturnValue({ select: () => chain() } as never);
}

/** The actor-scoped insert that queues the job; answers with one job id. */
function mockInsert(jobId: string) {
	const tx = {
		insert: () => ({
			values: () => ({ returning: async () => [{ id: jobId }] }),
		}),
	};
	vi.mocked(withActorScope).mockImplementation(
		async (_actor: unknown, fn: (t: never) => unknown) => fn(tx as never),
	);
}

const ENV_OK = [{ id: "e1" }];
const DEPLOY = [
	{
		user_id: "u1",
		project_id: "p1",
		cloud_identity_id: "ci-1",
		config_snapshot: {},
	},
];
const PLAN = [{ metadata: { plan_result: { resource_changes: [] } } }];
const QUOTA =
	"Free plan allows 25 provisioning jobs per day. You've hit the limit — it clears over the next 24 hours, or upgrade to remove it.";

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(assertJobQuotaAllowed).mockResolvedValue(undefined);
	mockInsert("job-9");
});

describe("queueClusterProbe — a refusal is a value", () => {
	it("returns 'never been deployed' when the environment has no successful DEPLOY", async () => {
		mockReads([ENV_OK, []]);
		await expect(queueClusterProbe("p1", "e1")).resolves.toEqual({
			ok: false,
			error:
				"This environment has never been deployed, so there's no cluster to probe.",
		});
		expect(withActorScope).not.toHaveBeenCalled();
	});

	it("returns 'already running' when a probe is in flight, and queues nothing", async () => {
		mockReads([ENV_OK, DEPLOY, [{ id: "job-1" }]]);
		await expect(queueClusterProbe("p1", "e1")).resolves.toEqual({
			ok: false,
			error: "A cluster probe is already running for this environment.",
		});
		expect(withActorScope).not.toHaveBeenCalled();
	});

	it("returns the free daily job quota's sentence", async () => {
		mockReads([ENV_OK, DEPLOY, []]);
		vi.mocked(assertJobQuotaAllowed).mockRejectedValue(
			new UsageLimitError(QUOTA, true),
		);
		await expect(queueClusterProbe("p1", "e1")).resolves.toEqual({
			ok: false,
			error: QUOTA,
		});
		expect(withActorScope).not.toHaveBeenCalled();
	});

	it("answers ok with the job id when the probe queues", async () => {
		mockReads([ENV_OK, DEPLOY, []]);
		await expect(queueClusterProbe("p1", "e1")).resolves.toEqual({
			ok: true,
			jobId: "job-9",
		});
	});
});

describe("queueEnvironmentAudit — a refusal is a value", () => {
	it("returns 'Run a plan first' when there is no successful PLAN", async () => {
		mockReads([ENV_OK, []]);
		await expect(queueEnvironmentAudit("p1", "e1")).resolves.toEqual({
			ok: false,
			error: "Run a plan first — there's nothing to audit yet.",
		});
		expect(withActorScope).not.toHaveBeenCalled();
	});

	it("returns 'already running' when an audit is in flight", async () => {
		mockReads([ENV_OK, PLAN, [{ id: "job-1" }]]);
		await expect(queueEnvironmentAudit("p1", "e1")).resolves.toEqual({
			ok: false,
			error: "An audit is already running for this environment.",
		});
		expect(withActorScope).not.toHaveBeenCalled();
	});

	it("returns the free daily job quota's sentence", async () => {
		mockReads([ENV_OK, PLAN, []]);
		vi.mocked(assertJobQuotaAllowed).mockRejectedValue(
			new UsageLimitError(QUOTA, true),
		);
		await expect(queueEnvironmentAudit("p1", "e1")).resolves.toEqual({
			ok: false,
			error: QUOTA,
		});
	});

	it("answers ok with the job id when the audit queues", async () => {
		mockReads([ENV_OK, PLAN, []]);
		await expect(queueEnvironmentAudit("p1", "e1")).resolves.toEqual({
			ok: true,
			jobId: "job-9",
		});
	});
});

describe("what is not a refusal still throws", () => {
	it("an environment outside the caller's project throws, for both actions", async () => {
		mockReads([[]]);
		await expect(queueClusterProbe("p1", "e-other")).rejects.toThrow(
			"Environment not found.",
		);
		mockReads([[]]);
		await expect(queueEnvironmentAudit("p1", "e-other")).rejects.toThrow(
			"Environment not found.",
		);
	});

	it("an unexpected quota-check failure is rethrown, not presented as advice", async () => {
		mockReads([ENV_OK, DEPLOY, []]);
		vi.mocked(assertJobQuotaAllowed).mockRejectedValue(
			new Error("connection terminated"),
		);
		await expect(queueClusterProbe("p1", "e1")).rejects.toThrow(
			"connection terminated",
		);
	});
});
