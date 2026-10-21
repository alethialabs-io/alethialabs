// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Mocked-boundary tests for the runner server actions: stub authorize + a thenable drizzle chain
// (withActorScope invokes the callback with a shared queue-backed `tx`, so sequential awaits inside
// one action resolve to the right rows), and assert the guard paths, returned shapes, the inserted
// values (operator/provisioning/job_type/config_snapshot), the hosted-vs-self-managed branches, the
// duplicate-destroy guard, and that notifyScaler fires after queueing jobs.

import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/authz/guard", () => ({ authorize: vi.fn() }));
vi.mock("@/lib/billing/job-quota", () => ({ assertJobQuotaAllowed: vi.fn() }));
vi.mock("@/lib/billing/config", () => ({ deploymentMode: vi.fn() }));
vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn(), withActorScope: vi.fn() }));
vi.mock("@/lib/queries/runner-usage", () => ({ queryProvisionedHours: vi.fn() }));
vi.mock("@/lib/runners/auth", () => ({ generateRunnerToken: vi.fn() }));
vi.mock("@/lib/scaler", () => ({ notifyScaler: vi.fn() }));

import {
	deployRunner,
	deployRunnerAction,
	destroyRunner,
	destroyRunnerAction,
	getAvailableRunners,
	getOnlineRunnerCount,
	getRunnersWithReleases,
	registerRunner,
	registerRunnerAction,
	removeRunner,
	removeRunnerAction,
	setDefaultRunner,
	setDefaultRunnerAction,
	updateRunner,
	updateRunnerAction,
} from "@/app/server/actions/runners";
import { UsageLimitError } from "@/lib/billing/usage-guard";
import { ForbiddenError } from "@/lib/authz/types";
import { authorize } from "@/lib/authz/guard";
import { deploymentMode } from "@/lib/billing/config";
import { getServiceDb, withActorScope } from "@/lib/db";
import { assertJobQuotaAllowed } from "@/lib/billing/job-quota";
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

describe("getRunnersWithReleases (the mention picker's and the agent tool's list)", () => {
	it("requires the view permission and answers the projected view, release flattened", async () => {
		mock.queue.push([
			{
				runner: { id: "r1", name: "Edge", operator: "self", org_id: "org-1", metadata: {} },
				release: {
					version: "1.2.0",
					release_notes: "notes",
					released_at: new Date("2026-01-02T00:00:00Z"),
					github_release_url: null,
					commit_sha: null,
					is_breaking: false,
				},
			},
			{ runner: { id: "r2", name: "NoRel", operator: "self", org_id: "org-1", metadata: {} }, release: null },
		]);
		const res = await getRunnersWithReleases();
		expect(authorize).toHaveBeenCalledWith("view", { type: "runner" });
		expect(res[0]).toMatchObject({ id: "r1", name: "Edge" });
		expect(res[0]).not.toHaveProperty("metadata");
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

	it("chooses the default within the addressed org: user, org and runner, in that order", async () => {
		vi.mocked(authorize).mockResolvedValue({ userId: "user-1", orgId: "org-1" } as never);
		await setDefaultRunner("r1");
		const q = new PgDialect().sqlToQuery(mock.execute.mock.calls[0][0]);
		expect(q.sql).toContain("set_default_runner(");
		expect(q.params).toEqual(["user-1", "org-1", "r1"]);
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
			[{ provider: "aws" }], // cloud identity lookup — gated BEFORE the insert
			[{ id: "r-dep", name: "Cloud" }], // runner insert .returning
			[{ id: "job-1" }], // job insert .returning
		);
		const res = await deployRunner({
			name: "Cloud",
			cloudIdentityId: "ci-1",
			region: "us-east-1",
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
		// job row: DEPLOY_RUNNER, queued, snapshot carries the resolved provider and NO token — the
		// token is minted at claim (lib/runners/lifecycle-token.ts), and the runner row's hash is one
		// whose plaintext was discarded.
		const jobValues = mock.valuesSpy.mock.calls[1][0];
		expect(jobValues).toMatchObject({
			job_type: "DEPLOY_RUNNER",
			status: "QUEUED",
			cloud_identity_id: "ci-1",
		});
		expect(jobValues.config_snapshot).toMatchObject({
			runner_id: "r-dep",
			cloud_provider: "aws",
			region: "us-east-1",
		});
		expect(jobValues.config_snapshot).not.toHaveProperty("runner_token");
		expect(JSON.stringify(jobValues)).not.toContain("tok-plain");
		expect(notifyScaler).toHaveBeenCalledTimes(1);
	});

	// `infra/templates/runner/` holds `aws` alone, so a gcp deploy could only die inside the
	// runner — after the runners row, the job row and the claim already existed. Refuse it at
	// enqueue, and write NOTHING.
	it("refuses a cloud with no runner template, before inserting anything", async () => {
		mock.queue.push([{ provider: "gcp" }]);
		await expect(
			deployRunner({
				name: "Cloud",
				cloudIdentityId: "ci-1",
				region: "europe-west1",
			}),
		).rejects.toThrow(/deployed runners are AWS only/i);
		expect(mock.valuesSpy).not.toHaveBeenCalled();
		expect(notifyScaler).not.toHaveBeenCalled();
	});

	it("refuses a missing identity instead of coercing it to an aws deploy", async () => {
		mock.queue.push([]); // no identity row
		await expect(
			deployRunner({
				name: "Cloud",
				cloudIdentityId: "ci-x",
				region: "us-east-1",
			}),
		).rejects.toThrow(/Cloud identity not found/);
		expect(mock.valuesSpy).not.toHaveBeenCalled();
		expect(notifyScaler).not.toHaveBeenCalled();
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
		// DESTROY carries no token at all — the runner uses a placeholder tfvar.
		expect(jobValues.config_snapshot).not.toHaveProperty("runner_token");
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

	// Day-2 on a runner deployed BEFORE the enqueue gate existed. Its identity row is gone, so
	// the provider can only come from what was recorded at deploy time — and it must be that,
	// not a hard-coded "aws" that would point `tofu destroy` at an entirely different cloud.
	// Note this path deliberately does NOT gate on RUNNER_DEPLOY_PROVIDERS: refusing here would
	// wedge a legacy runner's row with no way to tear it down.
	it("destroys a pre-gate GCP runner against gcp, not a hard-coded aws", async () => {
		mock.queue.push(
			[
				{
					...runnerRow,
					metadata: {
						deploy_config: {
							region: "europe-west1",
							cloud_provider: "gcp",
							image_tag: "v1",
						},
					},
				},
			],
			[], // identity row deleted since the deploy
			[], // no active lifecycle job
			[{ id: "job-del" }],
		);
		await destroyRunner("r-del");
		expect(mock.valuesSpy.mock.calls[0][0].config_snapshot).toMatchObject({
			cloud_provider: "gcp",
			region: "europe-west1",
		});
	});

	// Neither source knows the cloud. Guessing "aws" is how a destroy runs against an account
	// that never held this runner; a hard error puts the question in front of a human instead.
	it("refuses to guess a cloud when nothing recorded one", async () => {
		mock.queue.push(
			[
				{
					...runnerRow,
					metadata: { deploy_config: { region: "us-east-1", image_tag: "v1" } },
				},
			],
			[], // no identity row
			[], // no active lifecycle job
		);
		await expect(destroyRunner("r-del")).rejects.toThrow(
			/no recorded cloud provider/i,
		);
		expect(mock.valuesSpy).not.toHaveBeenCalled();
		expect(notifyScaler).not.toHaveBeenCalled();
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
			},
		},
	};

	it("queues an UPDATE_RUNNER job pinned to the latest release + retires the old token", async () => {
		mock.queue.push(
			[runnerRow], // runner lookup
			[{ provider: "aws" }], // identity lookup
			[], // no active lifecycle job for this runner
			[{ version: "3.4.5" }], // latest release
			[], // token_hash rotation update
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
		// The old credential is retired at enqueue (the row gets the hash of a discarded token) and
		// the job carries none: the claim mints the new one.
		expect(generateRunnerToken).toHaveBeenCalledTimes(1);
		expect(mock.setSpy).toHaveBeenCalledWith({ token_hash: "tok-hash" });
		expect(jobValues.config_snapshot).not.toHaveProperty("runner_token");
		expect(JSON.stringify(jobValues)).not.toContain("tok-plain");
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

	it("succeeds without a stored token — nothing is read from at rest (#945)", async () => {
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
			[], // no active lifecycle job
			[{ version: "3.4.5" }], // latest release
			[], // token_hash rotation update
			[{ id: "job-up" }], // job insert
		);
		const res = await updateRunner("r-up");
		expect(res).toEqual({ jobId: "job-up" });
		const jobValues = mock.valuesSpy.mock.calls[0][0];
		expect(jobValues.config_snapshot).not.toHaveProperty("runner_token");
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

describe("the mutation contract (defineAction wrappers, #6123)", () => {
	const R = "6f1c2a7e-3b4d-4e5f-8a9b-0c1d2e3f4a5b";

	it("answers ok with the function's result, through the SAME authorize the function runs", async () => {
		mock.queue.push([{ id: R }]);
		const res = await removeRunnerAction({ runnerId: R });
		expect(res).toEqual({ ok: true, data: { runnerId: R } });
		expect(authorize).toHaveBeenCalledWith("destroy", { type: "runner", id: R });
	});

	it("a malformed runner id is a validation result, and nothing is authorized or written", async () => {
		const res = await updateRunnerAction({ runnerId: "nope" });
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.error.kind).toBe("validation");
		expect(authorize).not.toHaveBeenCalled();
	});

	it("a runner the caller cannot see is a not-found result with its message, not an unexpected one", async () => {
		mock.queue.push([]);
		const res = await removeRunnerAction({ runnerId: R });
		expect(res).toEqual({ ok: false, error: { kind: "not-found", message: "Runner not found" } });
	});

	it("an overlapping lifecycle job is a conflict the user is told about", async () => {
		mock.queue.push([{ id: R, name: "w", cloud_identity_id: "ci", metadata: { deploy_config: { region: "eu-west-1", cloud_provider: "aws" } } }]);
		mock.queue.push([{ provider: "aws" }]);
		mock.queue.push([{ config_snapshot: { runner_id: R } }]);
		const res = await destroyRunnerAction({ runnerId: R });
		expect(res).toEqual({
			ok: false,
			error: { kind: "conflict", message: "A runner-lifecycle job is already in progress for this runner" },
		});
	});

	it("the plan's job cap is an entitlement refusal when upgrading lifts it, a conflict when it does not", async () => {
		mock.queue.push([{ id: R, name: "w", cloud_identity_id: "ci", metadata: { deploy_config: { region: "eu-west-1", cloud_provider: "aws" } } }]);
		mock.queue.push([{ provider: "aws" }]);
		vi.mocked(assertJobQuotaAllowed).mockRejectedValueOnce(new UsageLimitError("Daily cap", true));
		expect(await updateRunnerAction({ runnerId: R })).toEqual({
			ok: false,
			error: { kind: "entitlement", message: "Daily cap", feature: "" },
		});

		mock.queue.push([{ id: R, name: "w", cloud_identity_id: "ci", metadata: { deploy_config: { region: "eu-west-1", cloud_provider: "aws" } } }]);
		mock.queue.push([{ provider: "aws" }]);
		vi.mocked(assertJobQuotaAllowed).mockRejectedValueOnce(new UsageLimitError("Hard cap", false));
		expect(await updateRunnerAction({ runnerId: R })).toEqual({
			ok: false,
			error: { kind: "conflict", message: "Hard cap" },
		});
	});

	it("a PDP denial is a forbidden result", async () => {
		vi.mocked(authorize).mockRejectedValueOnce(new ForbiddenError("edit", { type: "runner", id: R }));
		const res = await setDefaultRunnerAction({ runnerId: R });
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.error.kind).toBe("forbidden");
	});

	it("an unexpected failure never leaks its message to the client", async () => {
		mock.execute.mockRejectedValueOnce(new Error("connection string postgres://secret"));
		const res = await setDefaultRunnerAction({ runnerId: null });
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.error).toEqual({ kind: "unexpected", ref: expect.any(String) });
		expect(JSON.stringify(res)).not.toContain("secret");
	});

	it("register validates the name the dialog validates, before anything is written", async () => {
		const res = await registerRunnerAction({ name: "   " });
		expect(res.ok).toBe(false);
		if (!res.ok && res.error.kind === "validation") expect(Object.keys(res.error.fields)).toEqual(["name"]);
		expect(mock.valuesSpy).not.toHaveBeenCalled();
	});

	it("deploy refuses a missing cloud account as not-found, before inserting anything", async () => {
		mock.queue.push([]);
		const res = await deployRunnerAction({ name: "w", cloudIdentityId: R, region: "eu-west-1" });
		expect(res).toEqual({ ok: false, error: { kind: "not-found", message: "Cloud identity not found" } });
		expect(mock.valuesSpy).not.toHaveBeenCalled();
	});
});
