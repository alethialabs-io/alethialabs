// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: the managed-pool per-org concurrency cap in claim_next_job() against REAL
// Postgres, under TRUE concurrency (a single-connection loop CANNOT reproduce the bug).
//
// The bug (TOCTOU): the managed Phase-B branch admits a job only while
// `org_managed_inflight(org) < plan_max_concurrency(plan)`, but FOR UPDATE SKIP LOCKED locks
// only the candidate JOB row, not the org's in-flight set. Under READ COMMITTED a concurrent
// claimer's uncommitted CLAIMED row is invisible to the count, and the broadcast runner-wake
// fans a claim to the whole pool at once -> every claimer snapshots inflight < cap and admits,
// blowing past the cap. The fix serializes admission PER ORG with a transaction-scoped advisory
// lock (`pg_advisory_xact_lock` keyed on org_id) and re-verifies the cap while holding it.
//
// Isolation: managed runners claim from the SHARED pool across ALL orgs, so each scenario seeds
// a dedicated cloud_identity and passes its id as p_cloud_identity_id, restricting the claim to
// this test's own jobs — deterministic even on a shared dev DB. Concurrency uses raw `postgres`
// connections (one per claimer) so the calls truly race; seeding/cleanup go through getServiceDb.

import { randomUUID } from "node:crypto";
import { inArray, sql } from "drizzle-orm";
import postgres from "postgres";
import { afterEach, expect, it } from "vitest";
import { getServiceDb } from "@/lib/db";
import { cloudIdentities, jobs, runners } from "@/lib/db/schema";
import { describeIfDb } from "./db";

/** One managed cloud identity → jobs keyed to it → claims filtered to it (test isolation). */
async function seedIdentity(org: string): Promise<string> {
	const [row] = await getServiceDb()
		.insert(cloudIdentities)
		.values({
			user_id: org,
			org_id: org,
			provider: "hetzner",
			name: `toctou-${org.slice(0, 8)}`,
		})
		.returning({ id: cloudIdentities.id });
	return row.id;
}

/** n ONLINE managed runners; returns [{id, hash}] for concurrent claim calls. */
async function seedRunners(
	n: number,
	tag: string,
): Promise<{ id: string; hash: string }[]> {
	const values = Array.from({ length: n }, () => {
		const id = randomUUID();
		return {
			id,
			name: `toctou-${tag}-${id.slice(0, 8)}`,
			operator: "managed" as const,
			token_hash: `h-${id}`,
			status: "ONLINE" as const,
		};
	});
	await getServiceDb().insert(runners).values(values);
	return values.map((v) => ({ id: v.id, hash: v.token_hash }));
}

/** n QUEUED managed DEPLOY jobs for org, keyed to cloudId, created_at staggered. */
async function seedJobs(
	n: number,
	org: string,
	cloudId: string,
): Promise<string[]> {
	const ids: string[] = [];
	for (let i = 0; i < n; i++) {
		const [row] = await getServiceDb()
			.insert(jobs)
			.values({
				user_id: org,
				org_id: org,
				cloud_identity_id: cloudId,
				job_type: "DEPLOY",
				status: "QUEUED",
				requires_self_runner: false,
			})
			.returning({ id: jobs.id });
		ids.push(row.id);
	}
	return ids;
}

async function inflight(org: string): Promise<number> {
	const rows = await getServiceDb().execute<{ n: number }>(
		sql`select public.org_managed_inflight(${org}::uuid)::int as n`,
	);
	return Number(rows[0].n);
}

async function claimedCount(org: string): Promise<number> {
	const rows = await getServiceDb().execute<{ n: number }>(
		sql`select count(*)::int as n from public.jobs where org_id = ${org}::uuid and status = 'CLAIMED'`,
	);
	return Number(rows[0].n);
}

/** Fire one claim_next_job per runner, each on its OWN connection, and count callers that got a job. */
async function concurrentClaim(
	claimers: { id: string; hash: string }[],
	cloudId: string,
): Promise<{ returned: number; errors: string[] }> {
	const url = process.env.ALETHIA_DATABASE_URL ?? "";
	const conns = claimers.map(() =>
		postgres(url, { max: 1, idle_timeout: 2, onnotice: () => {} }),
	);
	try {
		await Promise.all(conns.map((c) => c`select 1`)); // warm sockets → tight dispatch
		const settled = await Promise.allSettled(
			conns.map(
				(c, i) =>
					c`select id from public.claim_next_job(${claimers[i].id}::uuid, ${claimers[i].hash}, ${cloudId}::uuid)`,
			),
		);
		return {
			returned: settled.filter(
				(s) => s.status === "fulfilled" && s.value.length > 0,
			).length,
			errors: settled
				.filter((s) => s.status === "rejected")
				.map((s) => String((s as PromiseRejectedResult).reason)),
		};
	} finally {
		await Promise.all(conns.map((c) => c.end({ timeout: 5 })));
	}
}

describeIfDb("claim_next_job — managed-pool per-org concurrency cap (TOCTOU)", () => {
	const seededOrgs: string[] = [];
	const seededRunnerIds: string[] = [];
	const seededCloudIds: string[] = [];

	afterEach(async () => {
		if (seededOrgs.length) {
			await getServiceDb()
				.delete(jobs)
				.where(inArray(jobs.org_id, seededOrgs));
		}
		if (seededRunnerIds.length) {
			await getServiceDb()
				.delete(runners)
				.where(inArray(runners.id, seededRunnerIds));
		}
		if (seededCloudIds.length) {
			await getServiceDb()
				.delete(cloudIdentities)
				.where(inArray(cloudIdentities.id, seededCloudIds));
		}
		seededOrgs.length = 0;
		seededRunnerIds.length = 0;
		seededCloudIds.length = 0;
	});

	it("caps a community org at 2 under 6 concurrent claimers (no bypass)", async () => {
		const org = randomUUID();
		seededOrgs.push(org);
		const cloudId = await seedIdentity(org);
		seededCloudIds.push(cloudId);
		const claimers = await seedRunners(6, "s1");
		seededRunnerIds.push(...claimers.map((c) => c.id));
		await seedJobs(5, org, cloudId);

		const first = await concurrentClaim(claimers, cloudId);
		expect(first.errors).toEqual([]);

		// The cap is authoritative: at most 2 in-flight, never the pre-fix 5.
		expect(await inflight(org)).toBe(2);
		expect(await claimedCount(org)).toBe(2);

		// A second wave while already at the cap admits zero more.
		const second = await concurrentClaim(claimers, cloudId);
		expect(second.errors).toEqual([]);
		expect(await claimedCount(org)).toBe(2);
	});

	it("does not starve a second org: two orgs run concurrently, each capped at 2", async () => {
		const orgA = randomUUID();
		const orgB = randomUUID();
		seededOrgs.push(orgA, orgB);
		const cloudA = await seedIdentity(orgA);
		const cloudB = await seedIdentity(orgB);
		seededCloudIds.push(cloudA, cloudB);
		const claimersA = await seedRunners(6, "s2a");
		const claimersB = await seedRunners(6, "s2b");
		seededRunnerIds.push(
			...claimersA.map((c) => c.id),
			...claimersB.map((c) => c.id),
		);
		await seedJobs(5, orgA, cloudA);
		await seedJobs(5, orgB, cloudB);

		const [rA, rB] = await Promise.all([
			concurrentClaim(claimersA, cloudA),
			concurrentClaim(claimersB, cloudB),
		]);
		// Per-org advisory key → no deadlock and no cross-org serialization starvation.
		expect(rA.errors.filter((e) => /deadlock/i.test(e))).toEqual([]);
		expect(rB.errors.filter((e) => /deadlock/i.test(e))).toEqual([]);
		expect(await claimedCount(orgA)).toBe(2);
		expect(await claimedCount(orgB)).toBe(2);
	});
});
