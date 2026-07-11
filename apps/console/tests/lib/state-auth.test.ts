// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));
import { getServiceDb } from "@/lib/db";
import { resolveStateRequest } from "@/lib/runners/state-auth";
import { mintStateToken } from "@/lib/runners/state-token";
import { projectStateKey, runnerStateKey } from "@/lib/storage/tofu-state";

function mockJob(rows: unknown[]) {
	const db: Record<string, unknown> = {};
	Object.assign(db, {
		select: () => db,
		from: () => db,
		where: () => db,
		limit: () => Promise.resolve(rows),
	});
	vi.mocked(getServiceDb).mockReturnValue(db as never);
}

/** Request carrying the state token as the HTTP Basic password. */
function reqWithToken(token: string | null): Request {
	const headers: Record<string, string> = {};
	if (token) {
		headers.authorization = `Basic ${Buffer.from(`x:${token}`).toString("base64")}`;
	}
	return new Request("https://console.local/api/jobs/job-1/state", { headers });
}

const KEY = projectStateKey("p-1", "e-1");
const savedSecret = process.env.BETTER_AUTH_SECRET;

beforeEach(() => {
	vi.clearAllMocks();
	process.env.BETTER_AUTH_SECRET = "test-secret-bbbbbbbbbbbbbbbbbbbbbbbb";
});
afterEach(() => {
	if (savedSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
	else process.env.BETTER_AUTH_SECRET = savedSecret;
});

const activeJob = [{ project_id: "p-1", environment_id: "e-1", status: "PROCESSING" }];

async function resolve(rows: unknown[], token: string | null, jobId = "job-1") {
	mockJob(rows);
	return resolveStateRequest(reqWithToken(token), jobId);
}

describe("resolveStateRequest", () => {
	it("401s without a token", async () => {
		const r = await resolve(activeJob, null);
		expect("error" in r && r.error.status).toBe(401);
	});

	it("403s when the token is for another job", async () => {
		const tok = await mintStateToken({ jobId: "job-2", stateKey: KEY });
		const r = await resolve(activeJob, tok);
		expect("error" in r && r.error.status).toBe(403);
	});

	it("404s when the job doesn't exist", async () => {
		const tok = await mintStateToken({ jobId: "job-1", stateKey: KEY });
		const r = await resolve([], tok);
		expect("error" in r && r.error.status).toBe(404);
	});

	it("409s when the job is not running", async () => {
		const tok = await mintStateToken({ jobId: "job-1", stateKey: KEY });
		const r = await resolve(
			[{ project_id: "p-1", environment_id: "e-1", status: "SUCCESS" }],
			tok,
		);
		expect("error" in r && r.error.status).toBe(409);
	});

	it("400s when the job has no project environment", async () => {
		const tok = await mintStateToken({ jobId: "job-1", stateKey: KEY });
		const r = await resolve(
			[{ project_id: null, environment_id: null, status: "PROCESSING" }],
			tok,
		);
		expect("error" in r && r.error.status).toBe(400);
	});

	it("403s when the token key doesn't match the server-derived key", async () => {
		const tok = await mintStateToken({
			jobId: "job-1",
			stateKey: projectStateKey("other", "env"),
		});
		const r = await resolve(activeJob, tok);
		expect("error" in r && r.error.status).toBe(403);
	});

	it("resolves the server-derived key for a valid request", async () => {
		const tok = await mintStateToken({ jobId: "job-1", stateKey: KEY });
		const r = await resolve(activeJob, tok);
		expect(r).toEqual({ stateKey: KEY });
	});

	it("resolves a runner-lifecycle job to the target-runner state key", async () => {
		const runnerId = "a1b2c3d4-e5f6-4890-abcd-ef1234567890";
		const runnerKey = runnerStateKey(runnerId);
		const tok = await mintStateToken({ jobId: "job-1", stateKey: runnerKey });
		const r = await resolve(
			[
				{
					job_type: "DEPLOY_RUNNER",
					project_id: null,
					environment_id: null,
					config_snapshot: { runner_id: runnerId },
					status: "PROCESSING",
				},
			],
			tok,
		);
		expect(r).toEqual({ stateKey: runnerKey });
	});

	it("400s a runner-lifecycle job whose config_snapshot.runner_id is not a UUID", async () => {
		const tok = await mintStateToken({
			jobId: "job-1",
			stateKey: runnerStateKey("whatever"),
		});
		const r = await resolve(
			[
				{
					job_type: "DESTROY_RUNNER",
					project_id: null,
					environment_id: null,
					config_snapshot: { runner_id: "../projects/victim/env/tofu.tfstate" },
					status: "PROCESSING",
				},
			],
			tok,
		);
		expect("error" in r && r.error.status).toBe(400);
	});
});
