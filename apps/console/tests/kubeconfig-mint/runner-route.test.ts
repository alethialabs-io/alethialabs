// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// GET/POST /api/jobs/:id/kubeconfig-mint (#5281) — the runner's half of the mint channel, with the
// route AND lib/kubeconfig-mint/runner.ts real and only the database faked.
//
// The fake answers the two head SELECTs (the job, then the mint row the job serves) from fixtures, and
// records the result transaction: the row UPDATE's values and the `update_job_status` call, rendered
// to SQL + params by drizzle's own Postgres dialect. It does not evaluate WHERE clauses; the real
// predicates (status = 'pending', expires_at > now(), the job's runner) are driven against Postgres in
// tests/integration/kubeconfig-mint-routes.test.ts.

import { PgDialect } from "drizzle-orm/pg-core";
import { NextResponse } from "next/server";
import type { SQL } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	KUBECONFIG_MINT_FAILURE_REASONS,
	KUBECONFIG_MINT_UNKNOWN_FAILURE,
} from "@/lib/kubeconfig-mint/reasons";

const RUNNER = "11111111-1111-4111-8111-111111111111";
const OTHER_RUNNER = "22222222-2222-4222-8222-222222222222";
const JOB = "88888888-8888-4888-8888-888888888888";
const MINT = "77777777-7777-4777-8777-777777777777";
const OTHER_MINT = "66666666-6666-4666-8666-666666666666";
const CLUSTER = "44444444-4444-4444-8444-444444444444";
const KEY = "Qw9LmFlmUUWmsbonQCRIe9ZvA6LdV313U8aNfX0AwAw";
const SEALED = `${"A".repeat(40)}sealedCiphertextOnly${"b".repeat(30)}`;
/** What a cloud SDK's err.Error() can look like — the text the fixed set exists to keep out. */
const RAW_ERROR =
	"AccessDenied: https://sts.amazonaws.com/?X-Amz-Security-Token=FQoGZXIvYXdzEJr-secret-token";

interface JobFixture {
	id: string;
	runner_id: string | null;
	job_type: string;
	status: string;
}
interface MintFixture {
	id: string;
	mint_id: string;
	cluster_id: string;
	tier: "readonly" | "admin";
	shape: "exec" | "static";
	ttl_seconds: number;
	client_public_key: string;
	status: "pending" | "ready" | "failed" | "expired";
	expired_now: boolean;
}

let job: JobFixture | null = null;
let mintRow: MintFixture | null = null;
/** The values the result transaction's UPDATE set, if it ran. */
let updateSet: unknown = null;
/** Whether the UPDATE matched (false = lost the race to the sweep or a second post). */
let updateMatches = true;
/** update_job_status calls, rendered to SQL + params. */
const statusCalls: { sql: string; params: unknown[] }[] = [];
/** Make update_job_status raise this. */
let statusThrows: unknown = null;
const dialect = new PgDialect();

/** A drizzle-shaped select chain answering the next queued head read. */
function selectChain(queue: unknown[][]) {
	const chain = {
		from: () => chain,
		where: () => chain,
		limit: async () => queue.shift() ?? [],
	};
	return chain;
}

/** Builds the fake service DB for one request: job head, then mint head. */
function fakeDb() {
	const queue: unknown[][] = [job ? [job] : [], mintRow ? [mintRow] : []];
	const tx = {
		update: () => ({
			set: (v: unknown) => ({
				where: () => ({
					returning: async () => {
						if (!updateMatches) return [];
						updateSet = v;
						return [{ id: MINT }];
					},
				}),
			}),
		}),
		execute: async (q: SQL) => {
			const { sql, params } = dialect.sqlToQuery(q);
			statusCalls.push({ sql, params });
			if (statusThrows) throw statusThrows;
			return [{ applied: true }];
		},
	};
	return {
		select: () => selectChain(queue),
		transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
	};
}

vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));
vi.mock("@/lib/runners/auth", () => ({ verifyRunnerToken: vi.fn() }));
vi.mock("@/lib/billing/meter", () => ({ reportJobUsageOnce: vi.fn(async () => undefined) }));

const logged: unknown[] = [];
vi.mock("@/lib/observability/log", () => {
	const logger = {
		info: (...a: unknown[]) => logged.push(a),
		warn: (...a: unknown[]) => logged.push(a),
		error: (...a: unknown[]) => logged.push(a),
		debug: (...a: unknown[]) => logged.push(a),
		child: () => logger,
	};
	return { log: logger };
});

import { GET, POST } from "@/app/api/jobs/[id]/kubeconfig-mint/route";
import { reportJobUsageOnce } from "@/lib/billing/meter";
import { getServiceDb } from "@/lib/db";
import { verifyRunnerToken } from "@/lib/runners/auth";

/** An executing MINT_KUBECONFIG job held by RUNNER, with `over` applied. */
function mintJob(over: Partial<JobFixture> = {}): JobFixture {
	return { id: JOB, runner_id: RUNNER, job_type: "MINT_KUBECONFIG", status: "PROCESSING", ...over };
}

/** The pending mint row the job serves, with `over` applied. */
function pendingMint(over: Partial<MintFixture> = {}): MintFixture {
	return {
		id: MINT,
		mint_id: MINT,
		cluster_id: CLUSTER,
		tier: "readonly",
		shape: "exec",
		ttl_seconds: 3600,
		client_public_key: KEY,
		status: "pending",
		expired_now: false,
		...over,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	job = mintJob();
	mintRow = pendingMint();
	updateSet = null;
	updateMatches = true;
	statusCalls.length = 0;
	statusThrows = null;
	logged.length = 0;
	vi.mocked(verifyRunnerToken).mockResolvedValue({
		runnerId: RUNNER,
		tokenHash: "token-hash",
		operator: "managed",
		error: null,
	});
	freshDb();
});

/**
 * Arms a new fake for the next request. The route reads through getServiceDb() more than once per
 * request and each call must see the SAME remaining queue, so the fake is memoised on first use; a
 * test making a second request calls this between them.
 */
function freshDb(): void {
	vi.mocked(getServiceDb).mockReset();
	vi.mocked(getServiceDb).mockImplementation(() => {
		const db = fakeDb();
		vi.mocked(getServiceDb).mockReturnValue(db as never);
		return db as never;
	});
}

/** Calls GET for `jobId`. */
async function getSpec(jobId = JOB): Promise<Response> {
	return GET(new Request(`https://console.local/api/jobs/${jobId}/kubeconfig-mint`), {
		params: Promise.resolve({ id: jobId }),
	});
}

/** POSTs `body` for `jobId`. */
async function postResult(body: unknown, jobId = JOB): Promise<Response> {
	return POST(
		new Request(`https://console.local/api/jobs/${jobId}/kubeconfig-mint`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		}),
		{ params: Promise.resolve({ id: jobId }) },
	);
}

const READY = { status: "ready", mint_id: MINT, sealed: SEALED, private_endpoint: false };

describe("GET — the spec, for the owning runner only", () => {
	it("serves the owning runner the mint's spec (public key, no secret)", async () => {
		const res = await getSpec();
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			mint_id: MINT,
			cluster_id: CLUSTER,
			tier: "readonly",
			shape: "exec",
			ttl_seconds: 3600,
			client_public_key: KEY,
		});
		expect(res.headers.get("Cache-Control")).toBe("no-store");
	});

	it.each([
		["another runner's job", mintJob({ runner_id: OTHER_RUNNER }), 403],
		["an unclaimed job", mintJob({ runner_id: null, status: "QUEUED" }), 403],
		["a finished job", mintJob({ status: "SUCCESS" }), 403],
		["a job that is not a mint", mintJob({ job_type: "DEPLOY" }), 403],
		["no job at all", null, 404],
	] as const)("refuses %s", async (_name, j, status) => {
		job = j;
		const res = await getSpec();
		expect(res.status).toBe(status);
		expect(await res.text()).not.toContain(KEY);
		expect(res.headers.get("Cache-Control")).toBe("no-store");
	});

	it("410s a mint past its window, 409s one that already has a result", async () => {
		mintRow = pendingMint({ expired_now: true });
		expect((await getSpec()).status).toBe(410);
		mintRow = pendingMint({ status: "ready" });
		freshDb();
		expect((await getSpec()).status).toBe(409);
	});

	it("passes the runner-auth refusal through, marked no-store", async () => {
		vi.mocked(verifyRunnerToken).mockResolvedValueOnce({
			runnerId: "",
			tokenHash: "",
			operator: "",
			error: NextResponse.json({ error: "Invalid runner ID or token" }, { status: 401 }),
		});
		const res = await getSpec();
		expect(res.status).toBe(401);
		expect(res.headers.get("Cache-Control")).toBe("no-store");
	});
});

describe("POST — the one-shot result channel", () => {
	it("stores the ciphertext and completes the job SUCCESS, with the runner's own credentials", async () => {
		const res = await postResult(READY);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
		expect(updateSet).toEqual({
			status: "ready",
			sealed_result: SEALED,
			failure_reason: null,
			private_endpoint: false,
		});
		expect(statusCalls).toHaveLength(1);
		expect(statusCalls[0].sql).toContain("update_job_status");
		expect(statusCalls[0].params).toEqual([RUNNER, "token-hash", JOB, "SUCCESS", null]);
		expect(reportJobUsageOnce).toHaveBeenCalledWith(JOB);
	});

	it("refuses another runner, and writes nothing", async () => {
		job = mintJob({ runner_id: OTHER_RUNNER });
		const res = await postResult(READY);
		expect(res.status).toBe(403);
		expect(updateSet).toBeNull();
		expect(statusCalls).toHaveLength(0);
	});

	it("refuses a mint_id that is not the mint THIS job serves, and writes nothing", async () => {
		const res = await postResult({ ...READY, mint_id: OTHER_MINT });
		expect(res.status).toBe(403);
		expect(updateSet).toBeNull();
		expect(statusCalls).toHaveLength(0);
	});

	it("refuses a result past the window (410) or for a settled mint (409)", async () => {
		mintRow = pendingMint({ expired_now: true });
		expect((await postResult(READY)).status).toBe(410);
		mintRow = pendingMint({ status: "failed" });
		freshDb();
		expect((await postResult(READY)).status).toBe(409);
		expect(updateSet).toBeNull();
	});

	it("completes nothing when the guarded UPDATE lost the race to the sweep", async () => {
		updateMatches = false;
		const res = await postResult(READY);
		expect(res.status).toBe(409);
		expect(statusCalls).toHaveLength(0);
	});

	it("answers 409 when the job left this runner between the gate and the write", async () => {
		statusThrows = Object.assign(new Error("Failed query"), {
			cause: Object.assign(new Error("Job not owned"), { code: "AL409" }),
		});
		expect((await postResult(READY)).status).toBe(409);
	});

	it("refuses a body with a plaintext field riding along (strict), without echoing it", async () => {
		const res = await postResult({ ...READY, token: "plaintext-bearer" });
		expect(res.status).toBe(400);
		expect(await res.text()).not.toContain("plaintext-bearer");
		expect(updateSet).toBeNull();
	});
});

describe("POST — failure reasons come from the fixed set, never from the runner's text", () => {
	it.each(KUBECONFIG_MINT_FAILURE_REASONS)("stores a known reason verbatim: %s", async (reason) => {
		const res = await postResult({ status: "failed", mint_id: MINT, reason, private_endpoint: null });
		expect(res.status).toBe(200);
		expect(updateSet).toEqual({
			status: "failed",
			sealed_result: null,
			failure_reason: reason,
			private_endpoint: null,
		});
		expect(statusCalls[0].params).toEqual([RUNNER, "token-hash", JOB, "FAILED", reason]);
	});

	it("replaces raw runner text with the generic reason — in the row AND the job — and never logs it", async () => {
		const res = await postResult({
			status: "failed",
			mint_id: MINT,
			reason: RAW_ERROR,
			private_endpoint: true,
		});
		expect(res.status).toBe(200);
		expect(updateSet).toMatchObject({ failure_reason: KUBECONFIG_MINT_UNKNOWN_FAILURE });
		expect(statusCalls[0].params[4]).toBe(KUBECONFIG_MINT_UNKNOWN_FAILURE);
		expect(JSON.stringify(statusCalls)).not.toContain("secret-token");
		// It says THAT it replaced something, never what.
		expect(logged.length).toBeGreaterThan(0);
		expect(JSON.stringify(logged)).not.toContain("secret-token");
	});

	it("does not accept a known sentence with an error appended", async () => {
		await postResult({
			status: "failed",
			mint_id: MINT,
			reason: `${KUBECONFIG_MINT_FAILURE_REASONS[1]} ${RAW_ERROR}`,
			private_endpoint: null,
		});
		expect(updateSet).toMatchObject({ failure_reason: KUBECONFIG_MINT_UNKNOWN_FAILURE });
	});
});

describe("nothing secret reaches a log", () => {
	it("a server error logs the error's name, not the ciphertext it was carrying", async () => {
		statusThrows = new Error(`Failed query: update ... params: ${SEALED}`);
		const res = await postResult(READY);
		expect(res.status).toBe(500);
		expect(await res.text()).not.toContain(SEALED);
		expect(logged.length).toBeGreaterThan(0);
		expect(JSON.stringify(logged)).not.toContain(SEALED);
	});
});
