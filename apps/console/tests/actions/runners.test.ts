// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Mocked-boundary tests for the runner server actions: stub authorize + a thenable drizzle chain
// (withActorScope invokes the callback with a shared queue-backed `tx`, so sequential awaits inside
// one action resolve to the right rows), and assert the guard paths, returned shapes, the inserted
// values (operator/provisioning/job_type/config_snapshot), the hosted-vs-self-managed branches, the
// duplicate-destroy guard, and that notifyScaler fires after queueing jobs.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/authz/guard", () => ({ authorize: vi.fn() }));
vi.mock("@/lib/billing/config", () => ({ deploymentMode: vi.fn() }));
vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn(), withActorScope: vi.fn() }));
vi.mock("@/lib/queries/runner-usage", () => ({ queryProvisionedHours: vi.fn() }));
vi.mock("@/lib/runners/auth", () => ({ generateRunnerToken: vi.fn() }));
vi.mock("@/lib/scaler", () => ({ notifyScaler: vi.fn() }));

import {
	deployRunner,
	destroyRunner,
	getAvailableRunners,
	getLatestRunnerRelease,
	getManagedRunnerUsage,
	getManagedRunnersWithReleases,
	getOnlineRunnerCount,
	getRecentRunnerReleases,
	getReleaseNotes,
	getRunnersWithReleases,
	registerRunner,
	removeRunner,
	setDefaultRunner,
	updateRunner,
} from "@/app/server/actions/runners";
import { authorize } from "@/lib/authz/guard";
import { deploymentMode } from "@/lib/billing/config";
import { getServiceDb, withActorScope } from "@/lib/db";
import { queryProvisionedHours } from "@/lib/queries/runner-usage";
import { generateRunnerToken } from "@/lib/runners/auth";
import { notifyScaler } from "@/lib/scaler";

/**
 * A drizzle-ish chain whose builder methods return the chain and whose every `await`
 * resolves to the next seeded result-set (FIFO `queue`), so multiple sequential queries
 * inside one action each get their own rows. Spies capture the write payloads.
 */
function makeDb() {
	const queue: unknown[][] = [];
	const valuesSpy = vi.fn();
	const setSpy = vi.fn();
	const whereSpy = vi.fn();
	const deleteSpy = vi.fn();
	const execute = vi.fn().mockResolvedValue(undefined);
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
		orderBy: () => db,
		limit: () => db,
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
		delete: (...a: unknown[]) => {
			deleteSpy(...a);
			return db;
		},
		execute,
		then: (resolve: (v: unknown) => void) =>
			resolve(queue.length ? queue.shift() : []),
	});
	return { db, queue, valuesSpy, setSpy, whereSpy, deleteSpy, execute };
}

let mock: ReturnType<typeof makeDb>;

beforeEach(() => {
	vi.clearAllMocks();
	mock = makeDb();
	vi.mocked(authorize).mockResolvedValue({ userId: "user-1" } as never);
	// withActorScope just runs the callback against our shared chain.
	vi.mocked(withActorScope).mockImplementation(
		((_actor: { userId: string; orgId: string }, fn: (tx: unknown) => unknown) =>
			fn(mock.db)) as never,
	);
	vi.mocked(getServiceDb).mockReturnValue(mock.db as never);
	vi.mocked(generateRunnerToken).mockReturnValue({
		token: "tok-plain",
		hash: "tok-hash",
	});
	vi.mocked(deploymentMode).mockReturnValue("self-managed");
});

describe("getRunnersWithReleases", () => {
	it("requires the view permission and flattens the joined release", async () => {
		mock.queue.push([
			{
				runner: { id: "r1", name: "Edge", operator: "self" },
				release: {
					version: "1.2.0",
					release_notes: "notes",
					released_at: new Date("2026-01-02T00:00:00Z"),
					github_release_url: null,
					commit_sha: null,
					is_breaking: false,
				},
			},
			{ runner: { id: "r2", name: "NoRel", operator: "self" }, release: null },
		]);
		const res = await getRunnersWithReleases();
		expect(authorize).toHaveBeenCalledWith("view", { type: "runner" });
		expect(res[0]).toMatchObject({ id: "r1", name: "Edge" });
		// Date → ISO normalization on the joined release.
		expect(res[0].runner_releases?.released_at).toBe("2026-01-02T00:00:00.000Z");
		// leftJoin with no release row → null.
		expect(res[1].runner_releases).toBeNull();
	});

	it("propagates an authorize rejection (unauthorized)", async () => {
		vi.mocked(authorize).mockRejectedValueOnce(new Error("Forbidden") as never);
		await expect(getRunnersWithReleases()).rejects.toThrow(/Forbidden/);
	});
});

describe("getManagedRunnersWithReleases", () => {
	it("returns [] on the hosted SaaS without touching the service DB", async () => {
		vi.mocked(deploymentMode).mockReturnValue("hosted");
		expect(await getManagedRunnersWithReleases()).toEqual([]);
		expect(getServiceDb).not.toHaveBeenCalled();
	});

	it("reads managed runners via the service path on self-managed deployments", async () => {
		vi.mocked(deploymentMode).mockReturnValue("self-managed");
		mock.queue.push([
			{
				runner: { id: "m1", name: "Fleet", operator: "managed" },
				release: null,
			},
		]);
		const res = await getManagedRunnersWithReleases();
		expect(getServiceDb).toHaveBeenCalled();
		expect(res).toHaveLength(1);
		expect(res[0]).toMatchObject({ id: "m1", operator: "managed" });
	});
});

describe("getManagedRunnerUsage", () => {
	it("returns {} on hosted without querying the ledger", async () => {
		vi.mocked(deploymentMode).mockReturnValue("hosted");
		expect(await getManagedRunnerUsage()).toEqual({});
		expect(queryProvisionedHours).not.toHaveBeenCalled();
	});

	it("keys provisioned hours by runner id from the ledger query", async () => {
		vi.mocked(deploymentMode).mockReturnValue("self-managed");
		vi.mocked(queryProvisionedHours).mockResolvedValue([
			{ runner_id: "m1", provisioned_hours: 12 },
			{ runner_id: "m2", provisioned_hours: 3 },
		] as never);
		expect(await getManagedRunnerUsage()).toEqual({ m1: 12, m2: 3 });
		// Window starts at the first of the current UTC month.
		const arg = vi.mocked(queryProvisionedHours).mock.calls[0][1];
		expect(arg.from.getUTCDate()).toBe(1);
	});
});

describe("release readers", () => {
	it("getLatestRunnerRelease normalizes the date, or null when none", async () => {
		mock.queue.push([
			{
				version: "2.0.0",
				release_notes: "n",
				released_at: new Date("2026-03-01T00:00:00Z"),
				github_release_url: null,
				commit_sha: null,
				is_breaking: true,
			},
		]);
		const r = await getLatestRunnerRelease();
		expect(r?.released_at).toBe("2026-03-01T00:00:00.000Z");
		expect(r?.is_breaking).toBe(true);

		mock.queue.push([]);
		expect(await getLatestRunnerRelease()).toBeNull();
	});

	it("getRecentRunnerReleases maps every row to ISO release info", async () => {
		mock.queue.push([
			{
				version: "1.0.0",
				release_notes: "a",
				released_at: new Date("2026-01-01T00:00:00Z"),
				github_release_url: null,
				commit_sha: null,
				is_breaking: false,
			},
		]);
		const rows = await getRecentRunnerReleases(5);
		expect(rows).toHaveLength(1);
		expect(rows[0].released_at).toBe("2026-01-01T00:00:00.000Z");
	});

	it("getReleaseNotes returns the matched version or null", async () => {
		mock.queue.push([
			{
				version: "9.9.9",
				release_notes: "found",
				released_at: new Date("2026-05-05T00:00:00Z"),
				github_release_url: "https://x",
				commit_sha: "abc",
				is_breaking: false,
			},
		]);
		expect((await getReleaseNotes("9.9.9"))?.release_notes).toBe("found");

		mock.queue.push([]);
		expect(await getReleaseNotes("0.0.0")).toBeNull();
	});
});

describe("getOnlineRunnerCount", () => {
	it("returns the count value", async () => {
		mock.queue.push([{ value: 4 }]);
		expect(await getOnlineRunnerCount()).toBe(4);
	});

	it("defaults to 0 when no count row comes back", async () => {
		mock.queue.push([]);
		expect(await getOnlineRunnerCount()).toBe(0);
	});
});

describe("registerRunner", () => {
	it("inserts a self/registered runner and returns the one-time token", async () => {
		mock.queue.push([
			{
				id: "r-new",
				name: "BYO",
				operator: "self",
				provisioning: "registered",
				status: "OFFLINE",
				created_at: new Date(),
			},
		]);
		const res = await registerRunner("BYO");
		expect(authorize).toHaveBeenCalledWith("create", { type: "runner" });
		expect(res.runner_token).toBe("tok-plain");
		expect(res.runner?.id).toBe("r-new");
		// Stores the hash, never the plaintext, and pins operator/provisioning.
		const values = mock.valuesSpy.mock.calls[0][0];
		expect(values).toMatchObject({
			user_id: "user-1",
			name: "BYO",
			operator: "self",
			provisioning: "registered",
			token_hash: "tok-hash",
		});
	});
});

describe("setDefaultRunner", () => {
	it("authorizes edit on the runner and runs the set_default_runner SQL", async () => {
		await setDefaultRunner("r1");
		expect(authorize).toHaveBeenCalledWith("edit", { type: "runner", id: "r1" });
		expect(mock.execute).toHaveBeenCalledTimes(1);
	});

	it("clears the default (null) without an id on the resource", async () => {
		await setDefaultRunner(null);
		expect(authorize).toHaveBeenCalledWith("edit", {
			type: "runner",
			id: undefined,
		});
		expect(mock.execute).toHaveBeenCalledTimes(1);
	});
});

describe("getAvailableRunners", () => {
	it("returns the visible runner rows", async () => {
		mock.queue.push([{ id: "r1", name: "A", is_default: true }]);
		const res = await getAvailableRunners();
		expect(res).toHaveLength(1);
		expect(res[0]).toMatchObject({ id: "r1", is_default: true });
	});
});

describe("deployRunner", () => {
	it("inserts a deployed runner + DEPLOY_RUNNER job, then notifies the scaler", async () => {
		mock.queue.push(
			[{ id: "r-dep", name: "Cloud" }], // runner insert .returning
			[{ provider: "gcp" }], // cloud identity lookup
			[{ id: "job-1" }], // job insert .returning
		);
		const res = await deployRunner({
			name: "Cloud",
			cloudIdentityId: "ci-1",
			region: "europe-west1",
		});
		expect(authorize).toHaveBeenCalledWith("deploy", { type: "runner" });
		expect(res).toEqual({ runnerId: "r-dep", jobId: "job-1" });

		// runner row: self/deployed with the cloud identity attached.
		expect(mock.valuesSpy.mock.calls[0][0]).toMatchObject({
			operator: "self",
			provisioning: "deployed",
			cloud_identity_id: "ci-1",
			token_hash: "tok-hash",
		});
		// job row: DEPLOY_RUNNER, queued, snapshot carries the token + resolved provider.
		const jobValues = mock.valuesSpy.mock.calls[1][0];
		expect(jobValues).toMatchObject({
			job_type: "DEPLOY_RUNNER",
			status: "QUEUED",
			cloud_identity_id: "ci-1",
		});
		expect(jobValues.config_snapshot).toMatchObject({
			runner_id: "r-dep",
			runner_token: "tok-plain",
			cloud_provider: "gcp",
			region: "europe-west1",
		});
		expect(notifyScaler).toHaveBeenCalledTimes(1);
	});

	it("defaults the cloud provider to aws when the identity is missing", async () => {
		mock.queue.push(
			[{ id: "r-dep", name: "Cloud" }],
			[], // no identity row
			[{ id: "job-1" }],
		);
		await deployRunner({
			name: "Cloud",
			cloudIdentityId: "ci-x",
			region: "us-east-1",
		});
		expect(mock.valuesSpy.mock.calls[1][0].config_snapshot.cloud_provider).toBe(
			"aws",
		);
	});
});

describe("destroyRunner", () => {
	const runnerRow = {
		id: "r-del",
		name: "Doomed",
		cloud_identity_id: "ci-1",
		metadata: {
			deploy_config: {
				region: "us-east-1",
				cloud_provider: "aws",
				image_tag: "v1",
				runner_token: "deploy-tok",
			},
		},
	};

	it("queues a DESTROY_RUNNER job and notifies the scaler", async () => {
		mock.queue.push(
			[runnerRow], // fetchDeployedRunner: runner lookup
			[{ provider: "aws" }], // fetchDeployedRunner: identity lookup
			[], // active DESTROY_RUNNER jobs → none
			[{ id: "job-del" }], // job insert .returning
		);
		const res = await destroyRunner("r-del");
		expect(authorize).toHaveBeenCalledWith("destroy", {
			type: "runner",
			id: "r-del",
		});
		expect(res).toEqual({ jobId: "job-del" });
		const jobValues = mock.valuesSpy.mock.calls[0][0];
		expect(jobValues).toMatchObject({
			job_type: "DESTROY_RUNNER",
			status: "QUEUED",
		});
		expect(jobValues.config_snapshot.runner_token).toBe("deploy-tok");
		expect(notifyScaler).toHaveBeenCalledTimes(1);
	});

	it("throws when a destroy job is already in progress for the runner", async () => {
		mock.queue.push(
			[runnerRow],
			[{ provider: "aws" }],
			[{ id: "existing", config_snapshot: { runner_id: "r-del" } }], // duplicate
		);
		await expect(destroyRunner("r-del")).rejects.toThrow(/already in progress/);
		expect(notifyScaler).not.toHaveBeenCalled();
	});

	it("throws when the runner is not found", async () => {
		mock.queue.push([]); // fetchDeployedRunner runner lookup empty
		await expect(destroyRunner("missing")).rejects.toThrow(/Runner not found/);
	});

	it("throws when the runner has no deploy config", async () => {
		mock.queue.push(
			[{ id: "r-del", name: "X", cloud_identity_id: "ci-1", metadata: {} }],
		);
		await expect(destroyRunner("r-del")).rejects.toThrow(/no deploy config/);
	});

	it("throws when the runner has no cloud identity", async () => {
		mock.queue.push(
			[{ id: "r-del", name: "X", cloud_identity_id: null, metadata: {} }],
		);
		await expect(destroyRunner("r-del")).rejects.toThrow(/no cloud identity/);
	});
});

describe("updateRunner", () => {
	const runnerRow = {
		id: "r-up",
		name: "Aging",
		cloud_identity_id: "ci-1",
		metadata: {
			deploy_config: {
				region: "us-east-1",
				cloud_provider: "aws",
				image_tag: "v1",
				runner_token: "deploy-tok",
			},
		},
	};

	it("queues an UPDATE_RUNNER job pinned to the latest release version", async () => {
		mock.queue.push(
			[runnerRow], // runner lookup
			[{ provider: "aws" }], // identity lookup
			[], // no active lifecycle job for this runner
			[{ version: "3.4.5" }], // latest release
			[{ id: "job-up" }], // job insert
		);
		const res = await updateRunner("r-up");
		expect(authorize).toHaveBeenCalledWith("edit", {
			type: "runner",
			id: "r-up",
		});
		expect(res).toEqual({ jobId: "job-up" });
		const jobValues = mock.valuesSpy.mock.calls[0][0];
		expect(jobValues).toMatchObject({
			job_type: "UPDATE_RUNNER",
			status: "QUEUED",
		});
		expect(jobValues.config_snapshot.image_tag).toBe("3.4.5");
		expect(notifyScaler).toHaveBeenCalledTimes(1);
	});

	it("refuses when another lifecycle job is already active for the runner", async () => {
		mock.queue.push(
			[runnerRow], // runner lookup
			[{ provider: "aws" }], // identity lookup
			[{ id: "active", config_snapshot: { runner_id: "r-up" } }], // active DEPLOY/UPDATE/DESTROY
		);
		await expect(updateRunner("r-up")).rejects.toThrow(/already in progress/);
	});

	it("refuses when the deploy config has no runner token", async () => {
		mock.queue.push(
			[
				{
					id: "r-up",
					name: "Aging",
					cloud_identity_id: "ci-1",
					metadata: { deploy_config: { region: "us-east-1" } },
				},
			],
			[{ provider: "aws" }],
		);
		await expect(updateRunner("r-up")).rejects.toThrow(/missing deploy token/);
	});

	it("throws when there are no runner releases", async () => {
		mock.queue.push(
			[runnerRow],
			[{ provider: "aws" }],
			[], // no active lifecycle job for this runner
			[], // no releases
		);
		await expect(updateRunner("r-up")).rejects.toThrow(/No runner releases/);
	});
});

describe("removeRunner", () => {
	it("deletes the runner record after the ownership lookup", async () => {
		mock.queue.push([{ id: "r-rm" }]); // runner exists
		await removeRunner("r-rm");
		expect(authorize).toHaveBeenCalledWith("destroy", {
			type: "runner",
			id: "r-rm",
		});
		expect(mock.deleteSpy).toHaveBeenCalledTimes(1);
	});

	it("throws and does not delete when the runner is not found", async () => {
		mock.queue.push([]); // no runner
		await expect(removeRunner("nope")).rejects.toThrow(/Runner not found/);
		expect(mock.deleteSpy).not.toHaveBeenCalled();
	});
});
