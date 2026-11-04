// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration (#6122): the console's kubeconfig download, by cluster id, across orgs — against real
// Postgres, through the console's own actions (app/server/actions/kubeconfig-download.ts) and the
// mint library they share with the CLI routes.
//
// The property: a cluster id is honoured only inside the org the request is addressed to. A member of
// org A who names org B's cluster — or org B's mint — gets a refusal, and nothing is written or
// consumed. The positive controls (A downloads A's cluster; B's own mint is collectable by B) are what
// make each refusal mean "another org", not "this path is broken".
//
// The authz guard is stubbed (`authorize` / `authorizeQuiet` hand the actions an actor): the PDP's own
// decisions are the authz suite's subject. What is real is everything after it — the rate limit, the
// org-bound cluster resolution, the job/mint/audit transaction and the read-once poll.

import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { describeIfDb } from "./db";

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/authz/guard", () => ({ authorize: vi.fn(), authorizeQuiet: vi.fn() }));
vi.mock("@/lib/auth/trusted-ip", () => ({ trustedClientIp: vi.fn(() => "203.0.113.9") }));
vi.mock("@/lib/billing/usage-guard", async (orig) => ({
	...(await orig<typeof import("@/lib/billing/usage-guard")>()),
	assertUsageAllowed: vi.fn(),
}));
vi.mock("@/lib/scaler", () => ({ notifyScaler: vi.fn() }));

import {
	pollKubeconfigDownload,
	requestKubeconfigDownload,
} from "@/app/server/actions/kubeconfig-download";
import { authorize, authorizeQuiet } from "@/lib/authz/guard";
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
} from "@/lib/db/schema";

const ORG_A = randomUUID();
const ORG_B = randomUUID();
const USER_A = randomUUID();
const USER_B = randomUUID();
const PROJ_A = randomUUID();
const PROJ_B = randomUUID();
const ENV_A = randomUUID();
const ENV_B = randomUUID();
const CLUSTER_A = randomUUID();
const CLUSTER_B = randomUUID();
const KEY = "Qw9LmFlmUUWmsbonQCRIe9ZvA6LdV313U8aNfX0AwAw";

/** Points the stubbed guard at `userId` in `orgId`: the actor the address resolved. */
function actingAs(userId: string, orgId: string): void {
	vi.mocked(authorize).mockResolvedValue({ userId, orgId, credential: "session" });
	vi.mocked(authorizeQuiet).mockResolvedValue({ userId, orgId, credential: "session" });
}

/** Mint rows on `clusterId`. */
async function mintsOn(clusterId: string) {
	return getServiceDb()
		.select({ id: kubeconfigMintRequests.id })
		.from(kubeconfigMintRequests)
		.where(eq(kubeconfigMintRequests.cluster_id, clusterId));
}

describeIfDb("kubeconfig download — a cluster id is honoured only in its own org", () => {
	beforeAll(async () => {
		const db = getServiceDb();
		await db.insert(profiles).values([{ id: USER_A }, { id: USER_B }]);
		for (const [proj, org, user, env, cluster] of [
			[PROJ_A, ORG_A, USER_A, ENV_A, CLUSTER_A],
			[PROJ_B, ORG_B, USER_B, ENV_B, CLUSTER_B],
		] as const) {
			const [identity] = await db
				.insert(cloudIdentities)
				.values({ user_id: user, org_id: org, provider: "aws", name: `it-6122-${org.slice(0, 8)}` })
				.returning({ id: cloudIdentities.id });
			await db.insert(projects).values({
				id: proj,
				org_id: org,
				user_id: user,
				project_name: `it-6122-${proj.slice(0, 8)}`,
				region: "eu-west-1",
				iac_version: "1.0",
				cloud_identity_id: identity.id,
			});
			await db
				.insert(projectEnvironments)
				.values({ id: env, project_id: proj, user_id: user, name: "production", is_default: true, status: "ACTIVE" });
			await db
				.insert(projectCluster)
				.values({ id: cluster, project_id: proj, environment_id: env, cluster_name: `eks-${proj.slice(0, 8)}`, status: "ACTIVE" });
			// Both environments have deployed, so only the org binding can refuse the other org's cluster.
			await db.insert(jobs).values({
				user_id: user,
				org_id: org,
				project_id: proj,
				environment_id: env,
				job_type: "DEPLOY",
				status: "SUCCESS",
				config_snapshot: { cluster: `eks-${proj.slice(0, 8)}` },
			});
		}
	});

	afterAll(async () => {
		const db = getServiceDb();
		await db.delete(kubeconfigMintRequests).where(inArray(kubeconfigMintRequests.org_id, [ORG_A, ORG_B]));
		await db.delete(auditLog).where(inArray(auditLog.project_id, [PROJ_A, PROJ_B]));
		await db.delete(jobs).where(inArray(jobs.project_id, [PROJ_A, PROJ_B]));
		await db.delete(projects).where(inArray(projects.id, [PROJ_A, PROJ_B]));
		await db.delete(cloudIdentities).where(inArray(cloudIdentities.org_id, [ORG_A, ORG_B]));
		await db.delete(profiles).where(inArray(profiles.id, [USER_A, USER_B]));
	});

	it("control: a member of A downloading A's cluster is queued", async () => {
		actingAs(USER_A, ORG_A);
		const out = await requestKubeconfigDownload({ clusterId: CLUSTER_A, clientPublicKey: KEY });
		expect(out.ok).toBe(true);
		expect(await mintsOn(CLUSTER_A)).toHaveLength(1);
	});

	it("a member of A naming B's cluster is a 404 — no mint, no job, no audit row", async () => {
		actingAs(USER_A, ORG_A);
		const out = await requestKubeconfigDownload({ clusterId: CLUSTER_B, clientPublicKey: KEY });
		expect(out).toEqual({ ok: false, status: 404 });
		expect(await mintsOn(CLUSTER_B)).toEqual([]);
		const mintJobs = await getServiceDb()
			.select({ id: jobs.id })
			.from(jobs)
			.where(and(eq(jobs.project_id, PROJ_B), eq(jobs.job_type, "MINT_KUBECONFIG")));
		expect(mintJobs).toEqual([]);
		const audits = await getServiceDb()
			.select({ id: auditLog.id })
			.from(auditLog)
			.where(eq(auditLog.project_id, PROJ_B));
		expect(audits).toEqual([]);
	});

	it("a member of A polling B's mint by id gets nothing and consumes nothing", async () => {
		actingAs(USER_B, ORG_B);
		const own = await requestKubeconfigDownload({ clusterId: CLUSTER_B, clientPublicKey: KEY });
		if (!own.ok) throw new Error(`control: B could not request its own cluster (${own.status})`);

		actingAs(USER_A, ORG_A);
		for (const clusterId of [CLUSTER_B, CLUSTER_A]) {
			const out = await pollKubeconfigDownload({ clusterId, mintId: own.mintId });
			expect(out).toEqual({ ok: false, status: 404 });
		}
		// Still there for B to collect: A's polls read and deleted nothing.
		expect((await mintsOn(CLUSTER_B)).map((r) => r.id)).toEqual([own.mintId]);

		// Control: B's own poll reaches it (still pending — no runner has minted it).
		actingAs(USER_B, ORG_B);
		const mine = await pollKubeconfigDownload({ clusterId: CLUSTER_B, mintId: own.mintId });
		expect(mine.ok).toBe(true);
	});
});
