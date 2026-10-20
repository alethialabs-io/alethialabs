// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// POST /api/jobs/claim for a runner-lifecycle job: the target runner's bearer token is minted at
// claim and rides ONLY in the claim response (lib/runners/lifecycle-token.ts).
//   - A DEPLOY_RUNNER / UPDATE_RUNNER claim answers a snapshot carrying `runner_token`, whose hash is
//     the one written to the target's row — so the container the runner deploys can authenticate.
//   - The stored row is never written with it: the only jobs write on the happy path is none at all.
//   - A legacy row that still carries a token in its stored snapshot is served the FRESH one.
//   - A refused issue (the claiming runner is the target) fails the job and serves nothing.
//   - Other job types are served their snapshot untouched and rotate no runner.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { jobs, runners } from "@/lib/db/schema";
import { hashRunnerToken } from "@/lib/runners/auth";

const verifyRunnerToken = vi.fn();
vi.mock("@/lib/runners/auth", async (orig) => ({
	...(await orig<typeof import("@/lib/runners/auth")>()),
	verifyRunnerToken: (req: Request) => verifyRunnerToken(req),
}));
vi.mock("@/lib/runners/snapshot-sig", () => ({ verifySnapshot: () => true }));
vi.mock("@/lib/connectors/health", () => ({ markFailed: vi.fn() }));
vi.mock("@/lib/observability/metrics", () => ({ recordClaimLatency: vi.fn() }));
vi.mock("@/lib/observability/trace", () => ({ markJobSpan: vi.fn() }));
vi.mock("@/lib/crypto/secrets", () => ({ decryptSecret: () => ({}) }));

const EXECUTOR = "9b2e6c11-3f4a-4e7d-8a51-0c6d2e9f4b17";
const TARGET = "4f0c1d52-7a1e-4c55-9d0b-2b7f6a1e9c30";
const LEGACY_TOKEN = "LEGACY-stored-token-0d1f";

/** One recorded UPDATE. */
interface UpdateCall {
	table: unknown;
	values: Record<string, unknown>;
}

let jobRow: Record<string, unknown> = {};
let targetRowsPassingGuard: { id: string }[] = [];
let updates: UpdateCall[] = [];

/** A drizzle stand-in for the claim route: claim_next_job answers job-1; selects answer by table. */
function fakeDb() {
	return {
		execute: () => Promise.resolve([{ id: "job-1" }]),
		select: () => ({
			from: (table: unknown) => {
				const rows = table === jobs ? [jobRow] : table === runners ? [{ cloud_identity_id: null }] : [];
				const terminal = {
					limit: () => Promise.resolve(rows),
					then: (resolve: (v: unknown[]) => unknown) => resolve(rows),
				};
				const chain = { where: () => terminal, innerJoin: () => chain };
				return chain;
			},
		}),
		update: (table: unknown) => ({
			set: (values: Record<string, unknown>) => ({
				where: () => {
					updates.push({ table, values });
					const done = Promise.resolve();
					return Object.assign(done, {
						returning: () => Promise.resolve(table === runners ? targetRowsPassingGuard : []),
					});
				},
			}),
		}),
	};
}
vi.mock("@/lib/db", () => ({ getServiceDb: () => fakeDb() }));

/** Seeds the claimed job. */
function seed(jobType: string, snapshot: Record<string, unknown>) {
	jobRow = {
		id: "job-1",
		job_type: jobType,
		provider: "aws",
		user_id: "user-1",
		org_id: "org-1",
		cloud_identity_id: null,
		config_snapshot: snapshot,
		config_snapshot_sig: null,
		traceparent: null,
		created_at: new Date(),
	};
}

const claimBody = z.object({
	job: z.object({ config_snapshot: z.record(z.string(), z.unknown()) }),
});

/** Claims as `runnerId` and returns the status and body text. */
async function claim(runnerId = EXECUTOR) {
	verifyRunnerToken.mockResolvedValue({ runnerId, tokenHash: "h", operator: "self", error: null });
	const { POST } = await import("@/app/api/jobs/claim/route");
	const res = await POST(new Request("http://localhost/api/jobs/claim", { method: "POST" }));
	return { status: res.status, text: await res.text() };
}

beforeEach(() => {
	updates = [];
	targetRowsPassingGuard = [{ id: TARGET }];
});

describe("POST /api/jobs/claim — runner-lifecycle token handoff", () => {
	it.each(["DEPLOY_RUNNER", "UPDATE_RUNNER"])(
		"serves a %s claim the token whose hash the target row now holds",
		async (jobType) => {
			seed(jobType, { runner_id: TARGET, runner_name: "edge", region: "us-east-1" });
			const { status, text } = await claim();
			expect(status).toBe(200);

			const served = claimBody.parse(JSON.parse(text)).job.config_snapshot;
			const token = z.string().regex(/^[0-9a-f]{64}$/).parse(served.runner_token);
			expect(served).toMatchObject({ runner_id: TARGET, runner_name: "edge", region: "us-east-1" });

			const runnerWrites = updates.filter((u) => u.table === runners);
			expect(runnerWrites).toEqual([{ table: runners, values: { token_hash: hashRunnerToken(token) } }]);
			// The job row is never written with the token (nor at all, on the happy path).
			expect(updates.filter((u) => u.table === jobs)).toEqual([]);
			// The stored snapshot object the route read is unchanged.
			expect(jobRow.config_snapshot).not.toHaveProperty("runner_token");
		},
	);

	it("serves a legacy row the FRESH token, not the one its stored snapshot carries", async () => {
		seed("DEPLOY_RUNNER", { runner_id: TARGET, runner_token: LEGACY_TOKEN });
		const { status, text } = await claim();
		expect(status).toBe(200);
		expect(text).not.toContain(LEGACY_TOKEN);
		const served = claimBody.parse(JSON.parse(text)).job.config_snapshot;
		expect(updates).toEqual([
			{ table: runners, values: { token_hash: hashRunnerToken(String(served.runner_token)) } },
		]);
	});

	it("fails the job, and serves no token, when the claiming runner is the target", async () => {
		seed("UPDATE_RUNNER", { runner_id: TARGET });
		const { status, text } = await claim(TARGET);
		expect(status).toBe(409);
		expect(text).not.toMatch(/[0-9a-f]{64}/);
		expect(updates.filter((u) => u.table === runners)).toEqual([]);
		expect(updates).toEqual([
			{
				table: jobs,
				values: expect.objectContaining({
					status: "FAILED",
					error_message: expect.stringContaining("a runner cannot run its own lifecycle job"),
				}),
			},
		]);
	});

	it("fails the job when the target no longer passes the guard", async () => {
		targetRowsPassingGuard = [];
		seed("DEPLOY_RUNNER", { runner_id: TARGET });
		const { status } = await claim();
		expect(status).toBe(409);
		expect(updates.find((u) => u.table === jobs)?.values).toMatchObject({ status: "FAILED" });
	});

	it("serves any other job type its snapshot untouched and rotates no runner", async () => {
		seed("DESTROY_RUNNER", { runner_id: TARGET, runner_name: "edge" });
		const { status, text } = await claim();
		expect(status).toBe(200);
		expect(claimBody.parse(JSON.parse(text)).job.config_snapshot).toEqual({
			runner_id: TARGET,
			runner_name: "edge",
		});
		expect(updates).toEqual([]);
	});
});
