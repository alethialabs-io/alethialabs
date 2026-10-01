// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: kubeconfig_mint_requests (#5280) against real Postgres — the table that carries a
// client's ephemeral PUBLIC key and, once the runner posts, a SEALED credential only that client can
// open. Three claims, each driven in its failing direction:
//
//   1. The org binding is structural. A row whose cluster (or job) belongs to another org is refused
//      by the bind-org trigger, on the SERVICE role too — so a request route that resolved the
//      cluster wrongly cannot get a cross-tenant credential minted.
//   2. The RLS policy is org- AND actor-scoped: a teammate in the same org reads and deletes nothing,
//      another org reads nothing, the requester reads their own row.
//   3. The CHECKs hold the channel's shape: ciphertext exists iff `ready`, the TTL is 15m–8h, and the
//      client key is a 43-char base64url string.
//
// The RLS half needs the distinct app role (the migration role is BYPASSRLS) and skips without one —
// see APP_ROLE_DISTINCT in ./db. The trigger and CHECK halves run through the service role and run
// everywhere the database is up.

import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { getServiceDb, withScope } from "@/lib/db";
import {
	jobs,
	kubeconfigMintRequests,
	profiles,
	projectCluster,
	projectEnvironments,
	projects,
} from "@/lib/db/schema";
import { APP_ROLE_DISTINCT, describeIfDb, refusalText, seedJob } from "./db";

const ORG_A = randomUUID();
const ORG_B = randomUUID();
const USER_A = randomUUID();
const TEAMMATE_A = randomUUID();
const USER_B = randomUUID();
const PROJ_A = randomUUID();
const PROJ_B = randomUUID();
const CLUSTER_A = randomUUID();
const CLUSTER_B = randomUUID();
const KEY = "Qw9LmFlmUUWmsbonQCRIe9ZvA6LdV313U8aNfX0AwAw";
const jobIds: string[] = [];

/** A valid pending row for USER_A in ORG_A on CLUSTER_A, with `overrides` applied. */
function row(overrides: Partial<typeof kubeconfigMintRequests.$inferInsert> = {}) {
	return {
		org_id: ORG_A,
		cluster_id: CLUSTER_A,
		actor_user_id: USER_A,
		tier: "readonly" as const,
		ttl_seconds: 3600,
		shape: "exec" as const,
		client_public_key: KEY,
		expires_at: new Date(Date.now() + 600_000),
		...overrides,
	};
}

describeIfDb("kubeconfig_mint_requests — org binding, RLS, channel shape", () => {
	beforeAll(async () => {
		const db = getServiceDb();
		await db.insert(profiles).values([{ id: USER_A }, { id: TEAMMATE_A }, { id: USER_B }]);
		for (const [proj, org, user] of [
			[PROJ_A, ORG_A, USER_A],
			[PROJ_B, ORG_B, USER_B],
		] as const) {
			await db.insert(projects).values({
				id: proj,
				org_id: org,
				user_id: user,
				project_name: `p-${proj}`,
				region: "westeurope",
				iac_version: "1.0",
			});
		}
		const envA = randomUUID();
		const envB = randomUUID();
		await db.insert(projectEnvironments).values([
			{ id: envA, project_id: PROJ_A, user_id: USER_A, name: "production", is_default: true },
			{ id: envB, project_id: PROJ_B, user_id: USER_B, name: "production", is_default: true },
		]);
		await db.insert(projectCluster).values([
			{ id: CLUSTER_A, project_id: PROJ_A, environment_id: envA },
			{ id: CLUSTER_B, project_id: PROJ_B, environment_id: envB },
		]);
	});

	afterAll(async () => {
		const db = getServiceDb();
		await db
			.delete(kubeconfigMintRequests)
			.where(inArray(kubeconfigMintRequests.org_id, [ORG_A, ORG_B]));
		if (jobIds.length > 0) await db.delete(jobs).where(inArray(jobs.id, jobIds));
		await db.delete(projects).where(inArray(projects.id, [PROJ_A, PROJ_B]));
		await db.delete(profiles).where(inArray(profiles.id, [USER_A, TEAMMATE_A, USER_B]));
	});

	it("accepts a row whose cluster and MINT_KUBECONFIG job are in its own org", async () => {
		const job = await seedJob(USER_A, ORG_A, { job_type: "MINT_KUBECONFIG" });
		jobIds.push(job);
		const [inserted] = await getServiceDb()
			.insert(kubeconfigMintRequests)
			.values(row({ job_id: job }))
			.returning({ id: kubeconfigMintRequests.id, status: kubeconfigMintRequests.status });
		expect(inserted.status).toBe("pending");
	});

	it("refuses a row naming another org's cluster, even on the service role", async () => {
		const text = await refusalText(() =>
			getServiceDb().insert(kubeconfigMintRequests).values(row({ cluster_id: CLUSTER_B })),
		);
		expect(text).toContain("is not in org");
	});

	it("refuses a row naming another org's job, or a job that is not a mint", async () => {
		const foreign = await seedJob(USER_B, ORG_B, { job_type: "MINT_KUBECONFIG" });
		const plan = await seedJob(USER_A, ORG_A, { job_type: "PLAN" });
		jobIds.push(foreign, plan);
		for (const job of [foreign, plan]) {
			const text = await refusalText(() =>
				getServiceDb().insert(kubeconfigMintRequests).values(row({ job_id: job })),
			);
			expect(text).toContain("is not a MINT_KUBECONFIG job");
		}
	});

	it("refuses moving an existing row onto another org's cluster", async () => {
		const [r] = await getServiceDb()
			.insert(kubeconfigMintRequests)
			.values(row())
			.returning({ id: kubeconfigMintRequests.id });
		const text = await refusalText(() =>
			getServiceDb()
				.update(kubeconfigMintRequests)
				.set({ cluster_id: CLUSTER_B })
				.where(eq(kubeconfigMintRequests.id, r.id)),
		);
		expect(text).toContain("is not in org");
	});

	it("holds ciphertext only while ready, and only a well-formed key and TTL", async () => {
		const db = getServiceDb();
		const bad: Array<[string, Partial<typeof kubeconfigMintRequests.$inferInsert>]> = [
			["kubeconfig_mint_requests_sealed_iff_ready", { sealed_result: "A".repeat(66) }],
			["kubeconfig_mint_requests_sealed_iff_ready", { status: "ready" }],
			["kubeconfig_mint_requests_ttl_range", { ttl_seconds: 28_801 }],
			["kubeconfig_mint_requests_ttl_range", { ttl_seconds: 899 }],
			["kubeconfig_mint_requests_public_key_shape", { client_public_key: `${KEY}=` }],
			["kubeconfig_mint_requests_public_key_shape", { client_public_key: KEY.slice(0, 42) }],
			["kubeconfig_mint_requests_reason_only_when_failed", { failure_reason: "boom" }],
		];
		for (const [constraint, overrides] of bad) {
			const text = await refusalText(() =>
				db.insert(kubeconfigMintRequests).values(row(overrides)),
			);
			expect(text).toContain(constraint);
		}
		const [ready] = await db
			.insert(kubeconfigMintRequests)
			.values(row({ status: "ready", sealed_result: "A".repeat(66), private_endpoint: false }))
			.returning({ id: kubeconfigMintRequests.id });
		expect(ready.id).toBeTruthy();
	});

	it("RLS: the requester reads their own row; a teammate and another org read and delete nothing", async () => {
		if (!APP_ROLE_DISTINCT) return;
		const [mine] = await getServiceDb()
			.insert(kubeconfigMintRequests)
			.values(row({ status: "ready", sealed_result: "A".repeat(66), private_endpoint: false }))
			.returning({ id: kubeconfigMintRequests.id });
		const read = (ownerId: string, orgId: string) =>
			withScope({ ownerId, orgId }, (tx) =>
				tx
					.select({ id: kubeconfigMintRequests.id })
					.from(kubeconfigMintRequests)
					.where(eq(kubeconfigMintRequests.id, mine.id)),
			);
		expect(await read(USER_A, ORG_A)).toHaveLength(1);
		expect(await read(TEAMMATE_A, ORG_A)).toHaveLength(0);
		expect(await read(USER_B, ORG_B)).toHaveLength(0);

		const deleted = await withScope({ ownerId: TEAMMATE_A, orgId: ORG_A }, (tx) =>
			tx
				.delete(kubeconfigMintRequests)
				.where(eq(kubeconfigMintRequests.id, mine.id))
				.returning({ id: kubeconfigMintRequests.id }),
		);
		expect(deleted).toHaveLength(0);
		expect(await read(USER_A, ORG_A)).toHaveLength(1);
	});

	it("RLS: a requester cannot insert a row in their org on another member's behalf", async () => {
		if (!APP_ROLE_DISTINCT) return;
		const text = await refusalText(() =>
			withScope({ ownerId: TEAMMATE_A, orgId: ORG_A }, (tx) =>
				tx.insert(kubeconfigMintRequests).values(row({ actor_user_id: USER_A })),
			),
		);
		expect(text).toContain("row-level security");
	});
});
