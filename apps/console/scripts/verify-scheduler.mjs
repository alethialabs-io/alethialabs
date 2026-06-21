// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// Verifies the Phase 2 scheduler (priority · fairness · concurrency caps) against a
// real Postgres with the schema + programmables applied. Seeds throwaway orgs/runners/
// jobs, drives claim_next_job, asserts behavior, then cleans up. Run:
//
//   ALETHIA_DATABASE_URL=postgres://alethia:alethia-dev-secret@localhost:5433/alethia \
//     node apps/console/scripts/verify-scheduler.mjs
//
// (Apply the migration + programmables first: node apps/console/scripts/migrate.mjs)

import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import postgres from "postgres";

const url =
	process.env.ALETHIA_DATABASE_URL ??
	"postgres://alethia:alethia-dev-secret@localhost:5433/alethia";
const sql = postgres(url, { max: 1, prepare: false });

const MARK = "sched-verify"; // tag so cleanup only touches our rows
const token = "verify-token";
const tokenHash = createHash("sha256").update(token).digest("hex");

let failures = 0;
function check(label, cond) {
	if (cond) {
		console.log(`  ✓ ${label}`);
	} else {
		console.error(`  ✗ ${label}`);
		failures++;
	}
}

/** Claim one job as the given runner; return the claimed row (or undefined). */
async function claim(runnerId) {
	const rows = await sql`select * from claim_next_job(${runnerId}::uuid, ${tokenHash}, null)`;
	return rows[0];
}

/** Insert a QUEUED job for an org; returns its id. Priority is set by the trigger;
 *  an explicit provider is kept (trigger only fills it when null). */
async function queueJob(orgId, jobType = "DEPLOY", createdAt = null, provider = null) {
	const [row] = await sql`
		insert into jobs (user_id, org_id, job_type, status, created_at, provider)
		values (${randomUUID()}::uuid, ${orgId}::uuid, ${jobType}::provision_job_type, 'QUEUED',
		        ${createdAt ?? sql`now()`}, ${provider}::cloud_provider)
		returning id, priority, provider`;
	return row;
}

async function cleanup(ctx) {
	// jobs reference runners; delete jobs first, then runners (sessions cascade).
	if (ctx.orgIds?.length) {
		await sql`delete from jobs where org_id = any(${ctx.orgIds})`;
	}
	if (ctx.runnerIds?.length) {
		await sql`delete from runners where id = any(${ctx.runnerIds})`;
	}
	if (ctx.billingOrgId) {
		await sql`delete from organization_billing where organization_id = ${ctx.billingOrgId}`;
		await sql`delete from organization where id = ${ctx.billingOrgId}`;
	}
}

async function main() {
	const ctx = { orgIds: [], runnerIds: [] };
	try {
		// ── Runners: one managed (shared pool), one self ──
		const managedId = randomUUID();
		await sql`insert into runners (id, name, operator, token_hash, status)
		          values (${managedId}::uuid, ${`${MARK}-managed`}, 'managed', ${tokenHash}, 'ONLINE')`;
		ctx.runnerIds.push(managedId);

		const selfUser = randomUUID();
		const selfId = randomUUID();
		await sql`insert into runners (id, user_id, name, operator, provisioning, token_hash, status)
		          values (${selfId}::uuid, ${selfUser}::uuid, ${`${MARK}-self`}, 'self', 'registered', ${tokenHash}, 'ONLINE')`;
		ctx.runnerIds.push(selfId);

		// A lean per-cloud runner that only serves AWS.
		const awsRunnerId = randomUUID();
		await sql`insert into runners (id, name, operator, token_hash, status, supported_providers)
		          values (${awsRunnerId}::uuid, ${`${MARK}-aws`}, 'managed', ${tokenHash}, 'ONLINE', '{aws}'::cloud_provider[])`;
		ctx.runnerIds.push(awsRunnerId);

		// ── Orgs: business (active billing) + two community (no billing row) ──
		const [bizOrg] = await sql`insert into organization (name) values (${`${MARK}-biz`}) returning id`;
		await sql`insert into organization_billing (organization_id, plan, status)
		          values (${bizOrg.id}::uuid, 'business', 'active')`;
		ctx.billingOrgId = bizOrg.id;
		ctx.orgIds.push(bizOrg.id);

		const commA = randomUUID();
		const commB = randomUUID();
		ctx.orgIds.push(commA, commB);

		// === Test 1: priority — business beats community even when newer ===
		console.log("Test 1 — priority (business > community):");
		await sql`delete from jobs where org_id = any(${ctx.orgIds})`;
		const old = new Date(Date.now() - 60_000).toISOString();
		await queueJob(commA, "DEPLOY", old); // community, older
		const biz = await queueJob(bizOrg.id, "DEPLOY"); // business, newer
		check("business job has higher priority band", biz.priority === 20);
		const first = await claim(managedId);
		check("managed runner claims the business job first", first?.org_id === bizOrg.id);
		await sql`delete from jobs where org_id = any(${ctx.orgIds})`;

		// === Test 2: fairness — a burst doesn't starve a peer of equal tier ===
		console.log("Test 2 — fairness (within community band):");
		const t0 = Date.now();
		// commA: 3 older jobs; commB: 1 newer job (all community → priority 0)
		for (let i = 0; i < 3; i++) {
			await queueJob(commA, "DEPLOY", new Date(t0 + i).toISOString());
		}
		await queueJob(commB, "DEPLOY", new Date(t0 + 100).toISOString());
		const c1 = await claim(managedId); // tie in-flight 0/0 → oldest → commA
		const c2 = await claim(managedId); // commA now in-flight 1 → commB (0) wins
		check("1st claim goes to the bursting org (oldest)", c1?.org_id === commA);
		check("2nd claim goes to the peer, not the burst (fairness)", c2?.org_id === commB);
		await sql`delete from jobs where org_id = any(${ctx.orgIds})`;

		// === Test 3: cap — community stops at 2 in-flight on the shared pool ===
		console.log("Test 3 — concurrency cap (community = 2):");
		for (let i = 0; i < 4; i++) await queueJob(commA, "DEPLOY");
		const k1 = await claim(managedId);
		const k2 = await claim(managedId);
		const k3 = await claim(managedId); // commA at cap (2 in-flight) → skipped
		check("1st claim under cap", !!k1);
		check("2nd claim under cap", !!k2);
		check("3rd claim blocked by cap (no job returned)", k3 === undefined);
		await sql`delete from jobs where org_id = any(${ctx.orgIds})`;

		// === Test 4: self runner ignores caps (own capacity) ===
		console.log("Test 4 — self runner uncapped:");
		for (let i = 0; i < 3; i++) await queueJob(commB, "DEPLOY");
		const s1 = await claim(selfId);
		const s2 = await claim(selfId);
		const s3 = await claim(selfId); // would be blocked on managed; self is uncapped
		check("self runner claims past the community cap", !!s1 && !!s2 && !!s3);
		await sql`delete from jobs where org_id = any(${ctx.orgIds})`;

		// === Test 5: per-cloud routing ===
		console.log("Test 5 — per-cloud routing:");
		const awsJob = await queueJob(commA, "DEPLOY", null, "aws");
		const gcpJob = await queueJob(commB, "DEPLOY", null, "gcp");
		const r1 = await claim(awsRunnerId); // aws runner → AWS job
		check("aws runner claims the AWS job", r1?.id === awsJob.id);
		const r2 = await claim(awsRunnerId); // only the GCP job remains → not eligible
		check("aws runner skips the GCP job", r2 === undefined);
		const r3 = await claim(managedId); // any-provider runner → GCP job
		check("any-provider runner claims the GCP job", r3?.id === gcpJob.id);
		const nullJob = await queueJob(bizOrg.id, "DEPLOY", null, null); // no provider
		const r4 = await claim(awsRunnerId);
		check("aws runner claims a provider-less job", r4?.id === nullJob.id);
		await sql`delete from jobs where org_id = any(${ctx.orgIds})`;

		// === Test 6: fleet counting (Phase 4 — backlog + current by provider) ===
		console.log("Test 6 — fleet counting by provider:");
		await queueJob(commA, "DEPLOY", null, "aws");
		await queueJob(commB, "DEPLOY", null, "aws");
		await queueJob(commA, "DEPLOY", null, "gcp");
		const bl = await sql`select provider, count(*)::int n from jobs where status='QUEUED' group by provider`;
		const blMap = new Map(bl.map((r) => [r.provider, r.n]));
		check("backlog aws = 2", blMap.get("aws") === 2);
		check("backlog gcp = 1", blMap.get("gcp") === 1);
		// Managed ONLINE runners: managedId (null=any) + awsRunnerId ({aws}); selfId excluded.
		const curAws = await sql`select count(*)::int n from runners where operator='managed' and status='ONLINE' and (supported_providers is null or 'aws'::cloud_provider = any(supported_providers))`;
		check("managed runners serving aws = 2", curAws[0].n === 2);
		const curGcp = await sql`select count(*)::int n from runners where operator='managed' and status='ONLINE' and (supported_providers is null or 'gcp'::cloud_provider = any(supported_providers))`;
		check("managed runners serving gcp = 1 (only the any-provider runner)", curGcp[0].n === 1);
		await sql`delete from jobs where org_id = any(${ctx.orgIds})`;

		// === Test 7: job-minutes rollup (Phase 6 — managed runners only) ===
		console.log("Test 7 — job-minutes by org (managed only):");
		const mkDoneJob = (orgId, runnerId, mins) => sql`
			insert into jobs (user_id, org_id, job_type, status, runner_id, started_at, completed_at)
			values (${randomUUID()}::uuid, ${orgId}::uuid, 'DEPLOY'::provision_job_type, 'SUCCESS',
			        ${runnerId}::uuid, now() - make_interval(mins => ${mins}), now())`;
		await mkDoneJob(commA, managedId, 10); // managed → counts
		await mkDoneJob(commA, managedId, 5); // managed → counts
		await mkDoneJob(commA, selfId, 30); // self-operated → excluded
		const jm = await sql`
			select coalesce(sum(extract(epoch from (j.completed_at - j.started_at)) / 60.0), 0)::float8 as m
			from jobs j join runners r on r.id = j.runner_id
			where r.operator = 'managed' and j.org_id = ${commA}`;
		check("managed job-minutes for commA = 15 (self runner excluded)", Math.round(jm[0].m) === 15);
		await sql`delete from jobs where org_id = any(${ctx.orgIds})`;

		// === Test 8: bootstrap dedup (Phase 7 — one runner per VM instance) ===
		console.log("Test 8 — bootstrap dedup by instance id:");
		const bname = `${MARK}-fleet-inst-123`;
		const bootIns = (hash) => sql`
			insert into runners (name, operator, token_hash, supported_providers, metadata)
			values (${bname}, 'managed', ${hash}, '{aws}'::cloud_provider[],
			        ${JSON.stringify({ cloud_instance_id: "inst-123" })}::jsonb)
			on conflict (name) where operator = 'managed'
			do update set token_hash = excluded.token_hash
			returning id`;
		const [b1] = await bootIns("boot-hash-1");
		const [b2] = await bootIns("boot-hash-2"); // reboot: same instance → same row
		check("re-bootstrap reuses the same runner row", b1.id === b2.id);
		const bcnt = await sql`select count(*)::int n, max(token_hash) th from runners where name = ${bname}`;
		check("one row, token rotated to the latest", bcnt[0].n === 1 && bcnt[0].th === "boot-hash-2");
		await sql`delete from runners where name = ${bname}`;
	} finally {
		await cleanup(ctx);
		await sql.end();
	}

	if (failures > 0) {
		console.error(`\n${failures} check(s) failed.`);
		process.exit(1);
	}
	console.log("\nAll scheduler checks passed.");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
