// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// lib/kubeconfig-mint/request.ts (#5281) with the database faked — the decisions and their ORDER:
// which refusal wins, that the billing guards run before anything is written, and that the job, the
// request row and the audit row are written inside ONE transaction that has finished before the
// caller gets its answer (write-before). The real statements — the org filter on the cluster, the
// CHECKs, the bind-org trigger, RLS — run against Postgres in
// tests/integration/kubeconfig-mint-routes.test.ts.

import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "33333333-3333-4333-8333-333333333333";
const CLUSTER = "44444444-4444-4444-8444-444444444444";
const PROJECT = "55555555-5555-4555-8555-555555555555";
const ENV = "66666666-6666-4666-8666-666666666666";
const IDENTITY = "99999999-9999-4999-8999-999999999999";
const MINT = "77777777-7777-4777-8777-777777777777";
const JOB = "88888888-8888-4888-8888-888888888888";
const KEY = "Qw9LmFlmUUWmsbonQCRIe9ZvA6LdV313U8aNfX0AwAw";
const EXPIRES = new Date("2026-10-01T12:10:00.000Z");

/** Everything that happened, in order: reads, guards, transaction boundaries and inserts. */
const events: string[] = [];
/** The values of each insert inside the transaction, by table order. */
const inserted: unknown[] = [];

let target: Record<string, unknown> | null = null;
let deploy: Record<string, unknown> | null = null;

/** A select chain answering the next queued read. */
function selectChain(queue: (Record<string, unknown> | null)[]) {
	const chain = {
		from: () => chain,
		innerJoin: () => chain,
		leftJoin: () => chain,
		where: () => chain,
		orderBy: () => chain,
		limit: async () => {
			const r = queue.shift();
			events.push("read");
			return r ? [r] : [];
		},
	};
	return chain;
}

let queue: (Record<string, unknown> | null)[] = [];
let insertCount = 0;
const tx = {
	insert: () => ({
		values: (v: unknown) => {
			insertCount += 1;
			const n = insertCount;
			inserted.push(v);
			events.push(n === 1 ? "insert:job" : n === 2 ? "insert:mint" : "insert:audit");
			const returned =
				n === 1 ? [{ id: JOB }] : n === 2 ? [{ id: MINT, expires_at: EXPIRES }] : [];
			// The audit insert is awaited bare; the job and mint inserts call .returning().
			return Object.assign(Promise.resolve(returned), {
				returning: async () => returned,
			});
		},
	}),
};

vi.mock("@/lib/db", () => ({
	getServiceDb: () => ({ select: () => selectChain(queue) }),
	withActorScope: async (_actor: unknown, fn: (t: typeof tx) => Promise<unknown>) => {
		events.push("begin");
		const out = await fn(tx);
		events.push("commit");
		return out;
	},
}));
vi.mock("@/lib/billing/usage-guard", async (orig) => ({
	...(await orig<typeof import("@/lib/billing/usage-guard")>()),
	assertUsageAllowed: vi.fn(async () => {
		events.push("usage-guard");
	}),
}));
vi.mock("@/lib/billing/job-quota", () => ({
	assertJobQuotaAllowed: vi.fn(async () => {
		events.push("quota-guard");
	}),
}));
vi.mock("@/lib/scaler", () => ({ notifyScaler: vi.fn() }));
vi.mock("@/lib/runners/snapshot-sig", () => ({ signSnapshot: () => "sig" }));

import { requestKubeconfigMint } from "@/lib/kubeconfig-mint/request";

/** The resolved cluster row, with `over` applied. */
function cluster(over: Record<string, unknown> = {}) {
	return {
		clusterId: CLUSTER,
		projectId: PROJECT,
		environmentId: ENV,
		environmentStatus: "ACTIVE",
		cloudIdentityId: IDENTITY,
		provider: "aws",
		...over,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	events.length = 0;
	inserted.length = 0;
	insertCount = 0;
	target = cluster();
	deploy = { config_snapshot: { provider: "aws", cluster: { name: "eks-prod" } } };
});

/** Runs one request for `shape`/`tier` with the current fixtures. */
async function run(shape: "exec" | "static" = "exec", tier: "readonly" | "admin" = "readonly") {
	queue = [target, deploy];
	return requestKubeconfigMint({
		actor: { userId: USER, orgId: ORG },
		clusterId: CLUSTER,
		request: { tier, ttl_seconds: 3600, shape, client_public_key: KEY },
		client: "cli",
		credentialKind: "service_token",
		sourceIp: "203.0.113.7",
	});
}

describe("refusals", () => {
	it("a cluster the org query does not return is not-found, and nothing is written", async () => {
		target = null;
		expect(await run()).toEqual({ ok: false, refusal: "not-found" });
		expect(events).not.toContain("begin");
	});

	it.each(["hetzner", "alibaba"])("an exec mint on %s is static-only", async (provider) => {
		target = cluster({ provider });
		expect(await run("exec")).toEqual({ ok: false, refusal: "static-only" });
		target = cluster({ provider });
		expect((await run("static")).ok).toBe(true);
	});

	it.each(["digitalocean", "civo", null])("a cluster on %s has no minter", async (provider) => {
		target = cluster({ provider });
		expect(await run("static")).toEqual({ ok: false, refusal: "unsupported-cloud" });
	});

	it.each(["DRAFT", "DESTROYING", "DESTROYED", null])(
		"an environment in %s is not provisioned",
		async (environmentStatus) => {
			target = cluster({ environmentStatus });
			expect(await run()).toEqual({ ok: false, refusal: "not-provisioned" });
			expect(events).not.toContain("begin");
		},
	);

	it("an environment that never deployed successfully is not provisioned", async () => {
		deploy = null;
		expect(await run()).toEqual({ ok: false, refusal: "not-provisioned" });
		expect(events).not.toContain("usage-guard");
	});
});

describe("the write", () => {
	it("guards, then ONE transaction: job → request row → audit row, committed before it returns", async () => {
		const out = await run("exec", "admin");
		expect(events).toEqual([
			"read",
			"read",
			"usage-guard",
			"quota-guard",
			"begin",
			"insert:job",
			"insert:mint",
			"insert:audit",
			"commit",
		]);
		expect(out).toEqual({
			ok: true,
			mint: {
				id: MINT,
				cluster_id: CLUSTER,
				job_id: JOB,
				tier: "admin",
				shape: "exec",
				ttl_seconds: 3600,
				status: "pending",
				expires_at: EXPIRES,
			},
		});
	});

	it("enqueues a user-initiated MINT_KUBECONFIG job in the actor's org, on the cluster's identity", async () => {
		await run();
		expect(inserted[0]).toMatchObject({
			user_id: USER,
			org_id: ORG,
			project_id: PROJECT,
			environment_id: ENV,
			cloud_identity_id: IDENTITY,
			initiated_by: "user",
			job_type: "MINT_KUBECONFIG",
			status: "QUEUED",
			config_snapshot: { provider: "aws", cluster: { name: "eks-prod" } },
			config_snapshot_sig: "sig",
		});
	});

	it("writes the request row with the client's public key and nothing the runner owns", async () => {
		await run();
		expect(inserted[1]).toMatchObject({
			org_id: ORG,
			cluster_id: CLUSTER,
			job_id: JOB,
			actor_user_id: USER,
			tier: "readonly",
			ttl_seconds: 3600,
			shape: "exec",
			client_public_key: KEY,
		});
		expect(inserted[1]).not.toHaveProperty("sealed_result");
		expect(inserted[1]).not.toHaveProperty("status");
	});

	it("audits actor, cluster, tier, TTL, expiry, client and IP — and never the key", async () => {
		await run("exec", "admin");
		expect(inserted[2]).toEqual({
			project_id: PROJECT,
			user_id: USER,
			action: "CREATED",
			component_type: "kubeconfig_mint",
			component_id: MINT,
			changes: {
				event: "kubeconfig_mint.requested",
				mint_id: MINT,
				cluster_id: CLUSTER,
				job_id: JOB,
				tier: "admin",
				shape: "exec",
				ttl_seconds: 3600,
				request_expires_at: EXPIRES.toISOString(),
				credential_expires_by: new Date(EXPIRES.getTime() + 3_600_000).toISOString(),
				client: "cli",
				credential_kind: "service_token",
				source_ip: "203.0.113.7",
			},
		});
		expect(JSON.stringify(inserted[2])).not.toContain(KEY);
	});

	it("a failed audit insert fails the whole request — nothing commits, nothing is returned", async () => {
		tx.insert = () => ({
			values: (v: unknown) => {
				insertCount += 1;
				if (insertCount === 3) throw new Error("audit insert refused");
				inserted.push(v);
				const returned =
					insertCount === 1 ? [{ id: JOB }] : [{ id: MINT, expires_at: EXPIRES }];
				return Object.assign(Promise.resolve(returned), { returning: async () => returned });
			},
		});
		await expect(run()).rejects.toThrow("audit insert refused");
		expect(events).not.toContain("commit");
	});
});
