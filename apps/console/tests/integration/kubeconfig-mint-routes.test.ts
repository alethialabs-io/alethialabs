// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: the kubeconfig mint routes (#5281) end to end against real Postgres — the request, the
// runner's spec read and result post, the poll, and the expiry sweep, on the real statements.
//
// The mocked suites (tests/kubeconfig-mint/*) pin each route's decisions and their order. What only a
// database can settle, and what this file drives in its failing direction:
//
//   1. TENANCY. The request resolves the cluster with `org_id = actor.orgId`: org A asking for org B's
//      cluster is a 404 and writes nothing at all.
//   2. ONE TRANSACTION. A 202 means the job, the request row and the audit row all exist — and the job
//      carries the interactive priority bump (programmables.sql jobtype_priority_bump).
//   3. RUNNER OWNERSHIP. Only the runner holding the claimed job reads its spec or lands its result,
//      and only on the mint that job serves.
//   4. READ ONCE. The poll's DELETE … RETURNING serves the ciphertext once; the next poll is a 404. A
//      teammate in the same org cannot read — or consume — it.
//   5. FIXED REASONS. A runner's raw error text never reaches the row, the job or the poll.
//   6. EXPIRY. The sweep nulls an uncollected ciphertext, cancels a never-claimed job, and later deletes.
//   7. THE DAILY JOB QUOTA EXEMPTS MINTS (#5313). The REAL quota guard runs here: a community org at
//      its limit still gets a 202, the mint does not move the count, and a DEPLOY is still refused.
//   8. SHARED CLUSTERS ARE REFUSED UP FRONT (#5327). A namespace or vcluster environment is a 422
//      with the runner's own sentence, and no MINT_KUBECONFIG job exists afterwards.
//
// The CLI guard is stubbed (`authorizeCli` is the authz suite's subject; here it hands the handler an
// actor) and so are the runner-minute usage guard and the scaler poke; the daily job quota is real. The runner's credentials are REAL: two
// runners with hashed tokens, so `verifyRunnerToken` and `update_job_status` run as they do in
// production.

import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { z } from "zod";
import { describeIfDb } from "./db";

vi.mock("@/lib/authz/guard", () => ({ authorizeCli: vi.fn() }));
vi.mock("@/lib/auth/trusted-ip", () => ({ trustedClientIp: vi.fn(() => "203.0.113.9") }));
vi.mock("@/lib/billing/usage-guard", async (orig) => ({
	...(await orig<typeof import("@/lib/billing/usage-guard")>()),
	assertUsageAllowed: vi.fn(),
}));
vi.mock("@/lib/billing/meter", () => ({ reportJobUsageOnce: vi.fn() }));
vi.mock("@/lib/scaler", () => ({ notifyScaler: vi.fn() }));

import { GET as pollGet } from "@/app/api/cli/clusters/[id]/kubeconfig/[mintId]/route";
import { POST as requestPost } from "@/app/api/cli/clusters/[id]/kubeconfig/route";
import {
	GET as specGet,
	POST as resultPost,
} from "@/app/api/jobs/[id]/kubeconfig-mint/route";
import { authorizeCli } from "@/lib/authz/guard";
import { assertJobQuotaAllowed } from "@/lib/billing/job-quota";
import { UsageLimitError } from "@/lib/billing/usage-guard";
import { getServiceDb } from "@/lib/db";
import {
	auditLog,
	cloudIdentities,
	jobs,
	kubeconfigMintRequests,
	profiles,
	projectCluster,
	projectEnvironments,
	projects,
	runners,
} from "@/lib/db/schema";
import { KUBECONFIG_MINT_UNKNOWN_FAILURE } from "@/lib/kubeconfig-mint/reasons";
import { sweepExpiredKubeconfigMints } from "@/lib/kubeconfig-mint/sweep";
import { hashRunnerToken } from "@/lib/runners/auth";

const ORG_A = randomUUID();
const ORG_B = randomUUID();
const USER_A = randomUUID();
const TEAMMATE_A = randomUUID();
const USER_B = randomUUID();
const PROJ_A = randomUUID();
const PROJ_B = randomUUID();
const ENV_A = randomUUID();
const ENV_B = randomUUID();
const CLUSTER_A = randomUUID();
const CLUSTER_B = randomUUID();
// Two more environments of PROJ_A, placed on a shared cluster (#5327).
const ENV_NS = randomUUID();
const ENV_VC = randomUUID();
const CLUSTER_NS = randomUUID();
const CLUSTER_VC = randomUUID();
const RUNNER_1 = randomUUID();
const RUNNER_2 = randomUUID();
const TOKEN_1 = `it-mint-token-1-${randomUUID()}`;
const TOKEN_2 = `it-mint-token-2-${randomUUID()}`;
const KEY = "Qw9LmFlmUUWmsbonQCRIe9ZvA6LdV313U8aNfX0AwAw";
const SEALED = `${"A".repeat(40)}sealedCiphertextOnly${"b".repeat(30)}`;
const RAW_ERROR =
	"AccessDenied: https://sts.amazonaws.com/?X-Amz-Security-Token=FQoGZXIvYXdzEJr-secret-token";

const mintBody = z.object({ mint: z.object({ id: z.uuid(), job_id: z.uuid() }) });

/** Points the stubbed CLI guard at `userId` in `orgId` (a session). */
function actingAs(userId: string, orgId: string): void {
	vi.mocked(authorizeCli).mockResolvedValue({
		actor: { userId, orgId },
		credential: "session",
		orgScope: [orgId, userId],
	});
}

/** Requests a mint on `clusterId` as the current actor. */
async function request(clusterId: string, shape: "exec" | "static" = "exec"): Promise<Response> {
	return requestPost(
		new Request(`http://console.test/api/cli/clusters/${clusterId}/kubeconfig`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ shape, client_public_key: KEY }),
		}),
		{ params: Promise.resolve({ id: clusterId }) },
	);
}

/** Requests a mint on CLUSTER_A as USER_A and returns its ids. */
async function requestA(): Promise<{ mintId: string; jobId: string }> {
	actingAs(USER_A, ORG_A);
	const res = await request(CLUSTER_A);
	expect(res.status).toBe(202);
	const { mint } = mintBody.parse(await res.json());
	return { mintId: mint.id, jobId: mint.job_id };
}

/** Polls `mintId` on CLUSTER_A as the current actor. */
async function poll(mintId: string): Promise<Response> {
	return pollGet(
		new Request(`http://console.test/api/cli/clusters/${CLUSTER_A}/kubeconfig/${mintId}`),
		{ params: Promise.resolve({ id: CLUSTER_A, mintId }) },
	);
}

/** Runner headers for runner `id` with `token`. */
function runnerHeaders(id: string, token: string): HeadersInit {
	return { "X-Runner-ID": id, "X-Runner-Token": token, "content-type": "application/json" };
}

/** The runner's spec read for `jobId`. */
async function spec(jobId: string, runner: [string, string]): Promise<Response> {
	return specGet(
		new Request(`http://console.test/api/jobs/${jobId}/kubeconfig-mint`, {
			headers: runnerHeaders(...runner),
		}),
		{ params: Promise.resolve({ id: jobId }) },
	);
}

/** The runner's result post for `jobId`. */
async function result(jobId: string, runner: [string, string], body: unknown): Promise<Response> {
	return resultPost(
		new Request(`http://console.test/api/jobs/${jobId}/kubeconfig-mint`, {
			method: "POST",
			headers: runnerHeaders(...runner),
			body: JSON.stringify(body),
		}),
		{ params: Promise.resolve({ id: jobId }) },
	);
}

/** Hands `jobId` to RUNNER_1 the way claim_next_job does. */
async function claim(jobId: string): Promise<void> {
	await getServiceDb()
		.update(jobs)
		.set({ runner_id: RUNNER_1, status: "CLAIMED", claimed_at: new Date() })
		.where(eq(jobs.id, jobId));
}

/** The mint row, or undefined once it is gone. */
async function mintRow(mintId: string) {
	const [row] = await getServiceDb()
		.select()
		.from(kubeconfigMintRequests)
		.where(eq(kubeconfigMintRequests.id, mintId));
	return row;
}

/** The job row. */
async function jobRow(jobId: string) {
	const [row] = await getServiceDb().select().from(jobs).where(eq(jobs.id, jobId));
	return row;
}

const R1: [string, string] = [RUNNER_1, TOKEN_1];
const R2: [string, string] = [RUNNER_2, TOKEN_2];

describeIfDb("kubeconfig mint routes — request, runner, poll, sweep", () => {
	beforeAll(async () => {
		const db = getServiceDb();
		await db.insert(profiles).values([{ id: USER_A }, { id: TEAMMATE_A }, { id: USER_B }]);
		const [identityA] = await db
			.insert(cloudIdentities)
			.values({ user_id: USER_A, org_id: ORG_A, provider: "aws", name: `it-mint-${ORG_A.slice(0, 8)}` })
			.returning({ id: cloudIdentities.id });
		for (const [proj, org, user] of [
			[PROJ_A, ORG_A, USER_A],
			[PROJ_B, ORG_B, USER_B],
		] as const) {
			await db.insert(projects).values({
				id: proj,
				org_id: org,
				user_id: user,
				project_name: `p-${proj}`,
				region: "eu-west-1",
				iac_version: "1.0",
				cloud_identity_id: proj === PROJ_A ? identityA.id : null,
			});
		}
		await db.insert(projectEnvironments).values([
			{ id: ENV_A, project_id: PROJ_A, user_id: USER_A, name: "production", is_default: true, status: "ACTIVE" },
			{ id: ENV_B, project_id: PROJ_B, user_id: USER_B, name: "production", is_default: true, status: "ACTIVE" },
			{ id: ENV_NS, project_id: PROJ_A, user_id: USER_A, name: "preview-ns", is_default: false, status: "ACTIVE", placement_mode: "namespace" },
			{ id: ENV_VC, project_id: PROJ_A, user_id: USER_A, name: "preview-vc", is_default: false, status: "ACTIVE", placement_mode: "vcluster" },
		]);
		await db.insert(projectCluster).values([
			{ id: CLUSTER_A, project_id: PROJ_A, environment_id: ENV_A, cluster_name: "eks-a" },
			{ id: CLUSTER_B, project_id: PROJ_B, environment_id: ENV_B, cluster_name: "eks-b" },
			{ id: CLUSTER_NS, project_id: PROJ_A, environment_id: ENV_NS, cluster_name: "eks-shared-ns" },
			{ id: CLUSTER_VC, project_id: PROJ_A, environment_id: ENV_VC, cluster_name: "eks-shared-vc" },
		]);
		// Both environments have deployed, so only the org filter can refuse org B's cluster.
		await db.insert(jobs).values([
			{ user_id: USER_A, org_id: ORG_A, project_id: PROJ_A, environment_id: ENV_A, job_type: "DEPLOY", status: "SUCCESS", config_snapshot: { cluster: "eks-a" } },
			{ user_id: USER_B, org_id: ORG_B, project_id: PROJ_B, environment_id: ENV_B, job_type: "DEPLOY", status: "SUCCESS", config_snapshot: { cluster: "eks-b" } },
			// The shared environments have deployed too, so only their placement can refuse them.
			{ user_id: USER_A, org_id: ORG_A, project_id: PROJ_A, environment_id: ENV_NS, job_type: "DEPLOY", status: "SUCCESS", config_snapshot: { cluster: "eks-shared-ns", placement_mode: "namespace" } },
			{ user_id: USER_A, org_id: ORG_A, project_id: PROJ_A, environment_id: ENV_VC, job_type: "DEPLOY", status: "SUCCESS", config_snapshot: { cluster: "eks-shared-vc", placement_mode: "vcluster" } },
		]);
		await db.insert(runners).values([
			{ id: RUNNER_1, name: `it-mint-r1-${RUNNER_1.slice(0, 8)}`, operator: "managed", token_hash: hashRunnerToken(TOKEN_1), status: "ONLINE" },
			{ id: RUNNER_2, name: `it-mint-r2-${RUNNER_2.slice(0, 8)}`, operator: "managed", token_hash: hashRunnerToken(TOKEN_2), status: "ONLINE" },
		]);
	});

	afterAll(async () => {
		const db = getServiceDb();
		await db
			.delete(kubeconfigMintRequests)
			.where(inArray(kubeconfigMintRequests.org_id, [ORG_A, ORG_B]));
		await db.delete(auditLog).where(inArray(auditLog.project_id, [PROJ_A, PROJ_B]));
		await db.delete(jobs).where(inArray(jobs.project_id, [PROJ_A, PROJ_B]));
		await db.delete(projects).where(inArray(projects.id, [PROJ_A, PROJ_B]));
		await db.delete(cloudIdentities).where(eq(cloudIdentities.org_id, ORG_A));
		await db.delete(runners).where(inArray(runners.id, [RUNNER_1, RUNNER_2]));
		await db.delete(profiles).where(inArray(profiles.id, [USER_A, TEAMMATE_A, USER_B]));
	});

	let mintId = "";
	let jobId = "";

	it("a request writes the job, the pending row and the audit row together, in the actor's org", async () => {
		({ mintId, jobId } = await requestA());

		const job = await jobRow(jobId);
		expect(job).toMatchObject({
			org_id: ORG_A,
			project_id: PROJ_A,
			environment_id: ENV_A,
			job_type: "MINT_KUBECONFIG",
			status: "QUEUED",
			initiated_by: "user",
			// community plan band (0) + the interactive bump
			priority: 3,
		});
		expect(await mintRow(mintId)).toMatchObject({
			org_id: ORG_A,
			cluster_id: CLUSTER_A,
			job_id: jobId,
			actor_user_id: USER_A,
			status: "pending",
			sealed_result: null,
		});

		const audits = await getServiceDb()
			.select()
			.from(auditLog)
			.where(and(eq(auditLog.component_type, "kubeconfig_mint"), eq(auditLog.component_id, mintId)));
		expect(audits).toHaveLength(1);
		expect(audits[0]).toMatchObject({
			project_id: PROJ_A,
			user_id: USER_A,
			action: "CREATED",
			changes: { event: "kubeconfig_mint.requested", cluster_id: CLUSTER_A, tier: "readonly", source_ip: "203.0.113.9" },
		});
		expect(JSON.stringify(audits)).not.toContain(KEY);
	});

	it("org A asking for org B's cluster is a 404 and writes nothing", async () => {
		actingAs(USER_A, ORG_A);
		const res = await request(CLUSTER_B);
		expect(res.status).toBe(404);
		const rows = await getServiceDb()
			.select({ id: kubeconfigMintRequests.id })
			.from(kubeconfigMintRequests)
			.where(eq(kubeconfigMintRequests.cluster_id, CLUSTER_B));
		expect(rows).toEqual([]);
		const mintJobs = await getServiceDb()
			.select({ id: jobs.id })
			.from(jobs)
			.where(and(eq(jobs.project_id, PROJ_B), eq(jobs.job_type, "MINT_KUBECONFIG")));
		expect(mintJobs).toEqual([]);
	});

	it.each([
		["namespace", () => [CLUSTER_NS, ENV_NS]],
		["vcluster", () => [CLUSTER_VC, ENV_VC]],
	] as const)("a %s environment is a 422 with the runner's sentence, and no job or mint row is written (#5327)", async (_mode, ids) => {
		const [clusterId, envId] = ids();
		actingAs(TEAMMATE_A, ORG_A);
		const res = await request(clusterId, "static");
		expect(res.status).toBe(422);
		expect(await res.json()).toEqual({
			error: "Kubeconfig mints are not available for an environment placed on a shared cluster.",
		});
		const mintJobs = await getServiceDb()
			.select({ id: jobs.id })
			.from(jobs)
			.where(and(eq(jobs.environment_id, envId), eq(jobs.job_type, "MINT_KUBECONFIG")));
		expect(mintJobs).toEqual([]);
		const rows = await getServiceDb()
			.select({ id: kubeconfigMintRequests.id })
			.from(kubeconfigMintRequests)
			.where(eq(kubeconfigMintRequests.cluster_id, clusterId));
		expect(rows).toEqual([]);
	});

	it("only the runner holding the claimed job reads its spec", async () => {
		expect((await spec(jobId, R1)).status).toBe(403); // not claimed yet
		await claim(jobId);
		expect((await spec(jobId, R2)).status).toBe(403);
		const res = await spec(jobId, R1);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			mint_id: mintId,
			cluster_id: CLUSTER_A,
			tier: "readonly",
			shape: "exec",
			ttl_seconds: 3600,
			client_public_key: KEY,
		});
	});

	it("another runner cannot land a result, and the owner cannot land one on another mint", async () => {
		const ready = { status: "ready", mint_id: mintId, sealed: SEALED, private_endpoint: false };
		expect((await result(jobId, R2, ready)).status).toBe(403);
		expect((await result(jobId, R1, { ...ready, mint_id: randomUUID() })).status).toBe(403);
		expect(await mintRow(mintId)).toMatchObject({ status: "pending", sealed_result: null });
	});

	it("the owner's ready post stores ciphertext and completes the job", async () => {
		const res = await result(jobId, R1, { status: "ready", mint_id: mintId, sealed: SEALED, private_endpoint: false });
		expect(res.status).toBe(200);
		expect(await mintRow(mintId)).toMatchObject({ status: "ready", sealed_result: SEALED, private_endpoint: false });
		expect(await jobRow(jobId)).toMatchObject({ status: "SUCCESS" });
		// One shot: a second post finds nothing pending.
		expect((await result(jobId, R1, { status: "ready", mint_id: mintId, sealed: SEALED, private_endpoint: false })).status).not.toBe(200);
	});

	it("a teammate in the same org cannot read the mint, or consume it", async () => {
		actingAs(TEAMMATE_A, ORG_A);
		const res = await poll(mintId);
		expect(res.status).toBe(404);
		expect(await res.text()).not.toContain(SEALED);
		expect(await mintRow(mintId)).toMatchObject({ status: "ready" });
	});

	it("the requester reads the ciphertext ONCE; the row is gone and the delivery is audited", async () => {
		actingAs(USER_A, ORG_A);
		const first = await poll(mintId);
		expect(first.status).toBe(200);
		expect(first.headers.get("Cache-Control")).toBe("no-store");
		expect(await first.json()).toEqual({ status: "ready", private_endpoint: false, sealed: SEALED });

		const second = await poll(mintId);
		expect(second.status).toBe(404);
		expect(await mintRow(mintId)).toBeUndefined();

		const delivered = await getServiceDb()
			.select({ changes: auditLog.changes })
			.from(auditLog)
			.where(and(eq(auditLog.component_id, mintId), eq(auditLog.action, "STATUS_CHANGED")));
		expect(delivered).toHaveLength(1);
		expect(delivered[0].changes).toMatchObject({ event: "kubeconfig_mint.delivered" });
		expect(JSON.stringify(delivered)).not.toContain(SEALED);
	});

	it("a runner's raw error text never reaches the row, the job or the poll", async () => {
		const m = await requestA();
		await claim(m.jobId);
		const res = await result(m.jobId, R1, { status: "failed", mint_id: m.mintId, reason: RAW_ERROR, private_endpoint: null });
		expect(res.status).toBe(200);
		expect(await mintRow(m.mintId)).toMatchObject({ status: "failed", failure_reason: KUBECONFIG_MINT_UNKNOWN_FAILURE });
		const job = await jobRow(m.jobId);
		expect(job.status).toBe("FAILED");
		expect(job.error_message).toBe(KUBECONFIG_MINT_UNKNOWN_FAILURE);
		expect(JSON.stringify(job)).not.toContain("secret-token");

		actingAs(USER_A, ORG_A);
		expect(await (await poll(m.mintId)).json()).toEqual({
			status: "failed",
			private_endpoint: null,
			reason: KUBECONFIG_MINT_UNKNOWN_FAILURE,
		});
	});

	it("a pending mint whose job died without a result answers failed at once", async () => {
		const m = await requestA();
		await getServiceDb()
			.update(jobs)
			.set({ status: "FAILED", error_message: "unknown job type", completed_at: new Date() })
			.where(eq(jobs.id, m.jobId));
		actingAs(USER_A, ORG_A);
		expect(await (await poll(m.mintId)).json()).toEqual({
			status: "failed",
			private_endpoint: null,
			reason: KUBECONFIG_MINT_UNKNOWN_FAILURE,
		});
	});

	it("the sweep expires a never-claimed mint, cancels its job, and later deletes the row", async () => {
		const m = await requestA();
		await getServiceDb()
			.update(kubeconfigMintRequests)
			.set({ created_at: sql`now() - interval '15 minutes'`, expires_at: sql`now() - interval '1 minute'` })
			.where(eq(kubeconfigMintRequests.id, m.mintId));

		await sweepExpiredKubeconfigMints(getServiceDb());
		expect(await mintRow(m.mintId)).toMatchObject({ status: "expired", sealed_result: null });
		expect(await jobRow(m.jobId)).toMatchObject({ status: "CANCELLED" });
		actingAs(USER_A, ORG_A);
		expect(await (await poll(m.mintId)).json()).toEqual({ status: "expired", private_endpoint: null });

		await getServiceDb()
			.update(kubeconfigMintRequests)
			.set({ created_at: sql`now() - interval '40 minutes'`, expires_at: sql`now() - interval '30 minutes'` })
			.where(eq(kubeconfigMintRequests.id, m.mintId));
		await sweepExpiredKubeconfigMints(getServiceDb());
		expect(await mintRow(m.mintId)).toBeUndefined();
	});

	it("the sweep nulls an uncollected ciphertext past its window, and the poll never serves it", async () => {
		const m = await requestA();
		await claim(m.jobId);
		expect((await result(m.jobId, R1, { status: "ready", mint_id: m.mintId, sealed: SEALED, private_endpoint: true })).status).toBe(200);
		await getServiceDb()
			.update(kubeconfigMintRequests)
			.set({ created_at: sql`now() - interval '15 minutes'`, expires_at: sql`now() - interval '1 minute'` })
			.where(eq(kubeconfigMintRequests.id, m.mintId));

		// Before the sweep: past the window, so expired — and NOT consumed.
		actingAs(USER_A, ORG_A);
		expect(await (await poll(m.mintId)).json()).toEqual({ status: "expired", private_endpoint: true });

		await sweepExpiredKubeconfigMints(getServiceDb());
		expect(await mintRow(m.mintId)).toMatchObject({ status: "expired", sealed_result: null });
		// A job a runner held is left alone by the sweep.
		expect(await jobRow(m.jobId)).toMatchObject({ status: "SUCCESS" });
	});

	it("a community org at its daily job quota still mints, the mint does not count, and a DEPLOY is still refused (#5313)", async () => {
		// ORG_A has no billing row, so it is community. Every mint the tests above made is a
		// user-initiated job inside the window; none of them may count.
		vi.stubEnv("ALETHIA_FREE_DAILY_JOB_QUOTA", "3");
		try {
			// FAILED, so latestDeploySnapshot still reads the seeded SUCCESS deploy.
			const deploy: typeof jobs.$inferInsert = { user_id: USER_A, org_id: ORG_A, project_id: PROJ_A, environment_id: ENV_A, job_type: "DEPLOY", status: "FAILED", config_snapshot: {}, initiated_by: "user" };
			await getServiceDb().insert(jobs).values([deploy, deploy]);
			// Two user DEPLOYs: one under the cap of three.
			await expect(assertJobQuotaAllowed(ORG_A)).resolves.toBeUndefined();

			// The mint is queued — and leaves the count where it was, still one under the cap.
			await requestA();
			await expect(assertJobQuotaAllowed(ORG_A)).resolves.toBeUndefined();

			// A third DEPLOY reaches the cap: the next one is refused, and a mint is still served.
			await getServiceDb().insert(jobs).values(deploy);
			await expect(assertJobQuotaAllowed(ORG_A)).rejects.toBeInstanceOf(UsageLimitError);
			await requestA();
		} finally {
			vi.unstubAllEnvs();
		}
	});
});
