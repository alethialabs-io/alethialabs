// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));
import { getServiceDb } from "@/lib/db";
import { resolveStateRequest } from "@/lib/runners/state-auth";
import { mintStateToken } from "@/lib/runners/state-token";
import { projectStateKey, runnerStateKey } from "@/lib/storage/tofu-state";

type JobRow = Record<string, unknown>;

/**
 * Per-JOB-ID mock. The previous mock returned the SAME row for every query, which cannot express the
 * one situation this seam exists for: the token's job and the URL's job are DIFFERENT rows (a DEPLOY
 * reusing a PLAN's saved backend address). With a single-row mock the replay tests below would be
 * vacuous — they would pass no matter what the code did.
 */
function mockJobs(byId: Record<string, JobRow>) {
	vi.mocked(getServiceDb).mockReturnValue({
		select: () => ({
			from: () => ({
				where: (cond: unknown) => ({
					limit: () => {
						const id = extractId(cond, Object.keys(byId));
						const row = id ? byId[id] : undefined;
						return Promise.resolve(row ? [row] : []);
					},
				}),
			}),
		}),
	} as never);
}

/** Recovers the queried job id from drizzle's opaque `eq(jobs.id, <value>)` condition. */
function extractId(cond: unknown, known: string[]): string | null {
	const seen = new Set<unknown>();
	const walk = (n: unknown): string | null => {
		if (typeof n === "string") return known.includes(n) ? n : null;
		if (!n || typeof n !== "object" || seen.has(n)) return null;
		seen.add(n);
		for (const v of Object.values(n as Record<string, unknown>)) {
			const hit = walk(v);
			if (hit) return hit;
		}
		return null;
	};
	return walk(cond);
}

function reqWithToken(token: string | null): Request {
	const headers: Record<string, string> = {};
	if (token) {
		headers.authorization = `Basic ${Buffer.from(`x:${token}`).toString("base64")}`;
	}
	return new Request("https://console.local/api/jobs/job-1/state", { headers });
}

const KEY = projectStateKey("p-1", "e-1");
const OTHER_KEY = projectStateKey("p-2", "e-2");
const savedSecret = process.env.BETTER_AUTH_SECRET;

/** A job on project p-1 / env e-1 — i.e. addressing the state object under test. */
const job = (status: string, over: JobRow = {}): JobRow => ({
	job_type: "DEPLOY",
	project_id: "p-1",
	environment_id: "e-1",
	config_snapshot: {},
	status,
	...over,
});

beforeEach(() => {
	vi.clearAllMocks();
	process.env.BETTER_AUTH_SECRET = "test-secret-bbbbbbbbbbbbbbbbbbbbbbbb";
});
afterEach(() => {
	if (savedSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
	else process.env.BETTER_AUTH_SECRET = savedSecret;
});

async function resolve(
	byId: Record<string, JobRow>,
	token: string | null,
	pathJobId = "job-1",
) {
	mockJobs(byId);
	return resolveStateRequest(reqWithToken(token), pathJobId);
}

describe("resolveStateRequest", () => {
	it("401s without a token", async () => {
		const r = await resolve({ "job-1": job("PROCESSING") }, null);
		expect("error" in r && r.error.status).toBe(401);
	});

	it("403s on a garbage token", async () => {
		const r = await resolve({ "job-1": job("PROCESSING") }, "not-a-jwt");
		expect("error" in r && r.error.status).toBe(403);
	});

	it("404s when the token's job doesn't exist", async () => {
		const tok = await mintStateToken({ jobId: "ghost", stateKey: KEY });
		const r = await resolve({ "job-1": job("PROCESSING") }, tok);
		expect("error" in r && r.error.status).toBe(404);
	});

	it("409s when the token's job is not running (a finished job's token is dead)", async () => {
		const tok = await mintStateToken({ jobId: "job-1", stateKey: KEY });
		const r = await resolve({ "job-1": job("SUCCESS") }, tok);
		expect("error" in r && r.error.status).toBe(409);
	});

	it("400s when the job has no project environment", async () => {
		const tok = await mintStateToken({ jobId: "job-1", stateKey: KEY });
		const r = await resolve(
			{ "job-1": job("PROCESSING", { project_id: null, environment_id: null }) },
			tok,
		);
		expect("error" in r && r.error.status).toBe(400);
	});

	it("403s when the token key doesn't match the server-derived key (forged/stale claim)", async () => {
		const tok = await mintStateToken({ jobId: "job-1", stateKey: OTHER_KEY });
		const r = await resolve({ "job-1": job("PROCESSING") }, tok);
		expect("error" in r && r.error.status).toBe(403);
	});

	it("resolves the server-derived key for a valid request", async () => {
		const tok = await mintStateToken({ jobId: "job-1", stateKey: KEY });
		const r = await resolve({ "job-1": job("PROCESSING") }, tok);
		expect(r).toEqual({ stateKey: KEY });
	});

	// ── THE BUG (BUG#2) ──────────────────────────────────────────────────────────────────────────
	// OpenTofu embeds the backend config in a saved plan, and the backend address is per-job. So a
	// DEPLOY reusing a PLAN's artifact (the console's Plan→Apply button; the CLI's --plan-job-id)
	// hits the PLAN job's URL with its OWN token. That used to fail twice over: job-id mismatch
	// (403) and the PLAN being SUCCESS rather than PROCESSING (409) — surfacing as
	// "Error acquiring the state lock: HTTP remote state endpoint invalid auth", apply dead on
	// arrival. Both jobs share project+env ⇒ the SAME state object, so it must be allowed.
	it("ALLOWS a live DEPLOY's token at its finished PLAN's URL (same project+env ⇒ same state object)", async () => {
		const deployTok = await mintStateToken({ jobId: "deploy-1", stateKey: KEY });
		const r = await resolve(
			{
				"plan-1": job("SUCCESS", { job_type: "PLAN" }), // the URL baked into the saved plan
				"deploy-1": job("PROCESSING"), // the job actually applying
			},
			deployTok,
			"plan-1",
		);
		expect(r).toEqual({ stateKey: KEY });
	});

	// ── AND THE WALL MUST HOLD ───────────────────────────────────────────────────────────────────
	// The KEY — not the job id — is the scope. Aiming a token at another tenant's job URL must fail:
	// that job resolves to a different state object.
	it("403s a token replayed against a DIFFERENT project's job URL (cross-tenant)", async () => {
		const tok = await mintStateToken({ jobId: "mine", stateKey: KEY });
		const r = await resolve(
			{
				mine: job("PROCESSING"), // my live job on p-1/e-1
				victim: job("PROCESSING", { project_id: "p-2", environment_id: "e-2" }),
			},
			tok,
			"victim",
		);
		expect("error" in r && r.error.status).toBe(403);
	});

	it("403s a token replayed against a different ENVIRONMENT of the same project", async () => {
		const tok = await mintStateToken({ jobId: "mine", stateKey: KEY });
		const r = await resolve(
			{
				mine: job("PROCESSING"),
				other: job("PROCESSING", { environment_id: "e-9" }), // same project, other env
			},
			tok,
			"other",
		);
		expect("error" in r && r.error.status).toBe(403);
	});

	// Liveness is checked on the TOKEN's job, so a token from a finished job cannot be pointed at
	// someone else's in-flight job URL to revive itself.
	it("409s a finished job's token even when aimed at a live job's URL", async () => {
		const tok = await mintStateToken({ jobId: "done", stateKey: KEY });
		const r = await resolve(
			{ done: job("SUCCESS"), live: job("PROCESSING") },
			tok,
			"live",
		);
		expect("error" in r && r.error.status).toBe(409);
	});

	it("resolves a runner-lifecycle job to the target-runner state key", async () => {
		const runnerId = "a1b2c3d4-e5f6-4890-abcd-ef1234567890";
		const runnerKey = runnerStateKey(runnerId);
		const tok = await mintStateToken({ jobId: "job-1", stateKey: runnerKey });
		const r = await resolve(
			{
				"job-1": {
					job_type: "DEPLOY_RUNNER",
					project_id: null,
					environment_id: null,
					config_snapshot: { runner_id: runnerId },
					status: "PROCESSING",
				},
			},
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
			{
				"job-1": {
					job_type: "DESTROY_RUNNER",
					project_id: null,
					environment_id: null,
					config_snapshot: { runner_id: "../projects/victim/env/tofu.tfstate" },
					status: "PROCESSING",
				},
			},
			tok,
		);
		expect("error" in r && r.error.status).toBe(400);
	});
});
