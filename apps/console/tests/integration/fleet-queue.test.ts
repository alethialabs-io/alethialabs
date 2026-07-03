// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: the fleet queue-depth / backlog SQL against real Postgres — the GROUP BY
// provider bucketing, the managed-only + supported_providers WHERE filters (NULL = any),
// the busy EXISTS sub-select, the metadata->>'cloud_instance_id' keying, in-flight join,
// and the newest-release ordering. Seeds runners + jobs via getServiceDb() (bypasses RLS)
// with unique ids and cleans up by those ids. Global-scope counts (not org-scoped) are
// asserted as deltas against a baseline captured before seeding; row-returning functions
// are filtered to the seeded ids so concurrent dev-DB rows can't perturb assertions.

import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { getServiceDb } from "@/lib/db";
import { jobs, runnerReleases, runners } from "@/lib/db/schema";
import {
	backlogByProvider,
	countInflightForProvider,
	countManagedRunnersForProvider,
	latestReleaseVersion,
	managedRunnerRowsForProvider,
	managedRunnersByInstance,
} from "@/lib/fleet/queue";
import { describeIfDb } from "./db";

const ORG = randomUUID();

// Six runners with explicit ids so we can filter row results + clean up precisely.
const R1 = randomUUID(); // managed ONLINE  sp=[civo]    inst1  + CLAIMED job  (busy)
const R2 = randomUUID(); // managed ONLINE  sp=NULL      inst2  + PROCESSING   (busy, NULL=any)
const R3 = randomUUID(); // managed DRAINING sp=[civo]   inst3  (idle)
const R4 = randomUUID(); // managed ONLINE  sp=[hetzner] inst4  + CLAIMED (wrong provider)
const R5 = randomUUID(); // self    ONLINE  sp=[civo]    inst5  + CLAIMED (not managed)
const R6 = randomUUID(); // managed ONLINE  sp=[civo]    NO instance, NO heartbeat
const RUNNER_IDS = [R1, R2, R3, R4, R5, R6];

// Unique cloud_instance_ids so the by-instance map can't collide with real dev rows.
const INST1 = `it-inst-${R1.slice(0, 8)}`;
const INST2 = `it-inst-${R2.slice(0, 8)}`;
const INST3 = `it-inst-${R3.slice(0, 8)}`;
const INST4 = `it-inst-${R4.slice(0, 8)}`;
const INST5 = `it-inst-${R5.slice(0, 8)}`;

const RELEASE_ID = randomUUID();
const RELEASE_VERSION = `it-v9.9.9-${RELEASE_ID.slice(0, 8)}`;

const t = (offsetMin: number) =>
	new Date(Date.UTC(2026, 0, 1, 0, offsetMin, 0));

// Baselines for the global (non-org-scoped) count functions, captured before seeding.
let baseBacklog: Map<string, number>;
let baseManagedCivo = 0;
let baseInflightCivo = 0;

describeIfDb("fleet queue SQL", () => {
	beforeAll(async () => {
		const db = getServiceDb();

		// Snapshot global state BEFORE seeding so we can assert exact deltas.
		baseBacklog = await backlogByProvider();
		baseManagedCivo = await countManagedRunnersForProvider("civo");
		baseInflightCivo = await countInflightForProvider("civo");

		await db.insert(runners).values([
			{
				id: R1,
				name: `it-fq-r1-${R1.slice(0, 8)}`,
				operator: "managed",
				token_hash: `h-${R1}`,
				status: "ONLINE",
				supported_providers: ["civo"],
				location: "fsn1",
				version: "1.2.3",
				metadata: { cloud_instance_id: INST1 },
				last_heartbeat: t(0),
				created_at: t(1),
			},
			{
				id: R2,
				name: `it-fq-r2-${R2.slice(0, 8)}`,
				operator: "managed",
				token_hash: `h-${R2}`,
				status: "ONLINE",
				supported_providers: null,
				metadata: { cloud_instance_id: INST2 },
				last_heartbeat: t(0),
				created_at: t(2),
			},
			{
				id: R3,
				name: `it-fq-r3-${R3.slice(0, 8)}`,
				operator: "managed",
				token_hash: `h-${R3}`,
				status: "DRAINING",
				supported_providers: ["civo"],
				metadata: { cloud_instance_id: INST3 },
				last_heartbeat: t(0),
				created_at: t(3),
			},
			{
				id: R4,
				name: `it-fq-r4-${R4.slice(0, 8)}`,
				operator: "managed",
				token_hash: `h-${R4}`,
				status: "ONLINE",
				supported_providers: ["hetzner"],
				metadata: { cloud_instance_id: INST4 },
				last_heartbeat: t(0),
				created_at: t(4),
			},
			{
				id: R5,
				name: `it-fq-r5-${R5.slice(0, 8)}`,
				user_id: ORG, // self ⇒ user_id NOT NULL (CHECK)
				org_id: ORG,
				operator: "self",
				provisioning: "registered",
				token_hash: `h-${R5}`,
				status: "ONLINE",
				supported_providers: ["civo"],
				metadata: { cloud_instance_id: INST5 },
				last_heartbeat: t(0),
				created_at: t(5),
			},
			{
				id: R6,
				name: `it-fq-r6-${R6.slice(0, 8)}`,
				operator: "managed",
				token_hash: `h-${R6}`,
				status: "ONLINE",
				supported_providers: ["civo"],
				metadata: {}, // no cloud_instance_id, no heartbeat
				created_at: t(6),
			},
		]);

		// Backlog: QUEUED jobs grouped by provider. 3 civo + 1 hetzner + 2 provider-less
		// ("any") + 1 civo SUCCESS that must be excluded (not QUEUED).
		await db.insert(jobs).values([
			...["civo", "civo", "civo"].map((provider) => ({
				user_id: ORG,
				org_id: ORG,
				job_type: "PLAN" as const,
				status: "QUEUED" as const,
				config_snapshot: {},
				provider: provider as "civo",
			})),
			{
				user_id: ORG,
				org_id: ORG,
				job_type: "PLAN",
				status: "QUEUED",
				config_snapshot: {},
				provider: "hetzner",
			},
			...[1, 2].map(() => ({
				user_id: ORG,
				org_id: ORG,
				job_type: "PLAN" as const,
				status: "QUEUED" as const,
				config_snapshot: {},
				provider: null,
			})),
			{
				user_id: ORG,
				org_id: ORG,
				job_type: "PLAN",
				status: "SUCCESS",
				config_snapshot: {},
				provider: "civo",
			},
		]);

		// In-flight jobs (drive busy + countInflight). Runner support gates the provider
		// filter, NOT the job.provider, so leave those null.
		await db.insert(jobs).values([
			{ user_id: ORG, org_id: ORG, job_type: "PLAN", status: "CLAIMED", config_snapshot: {}, runner_id: R1 },
			{ user_id: ORG, org_id: ORG, job_type: "PLAN", status: "PROCESSING", config_snapshot: {}, runner_id: R2 },
			{ user_id: ORG, org_id: ORG, job_type: "PLAN", status: "CLAIMED", config_snapshot: {}, runner_id: R4 },
			{ user_id: ORG, org_id: ORG, job_type: "PLAN", status: "CLAIMED", config_snapshot: {}, runner_id: R5 },
			// Terminal job on R1 — must not count as in-flight nor mark it busy on its own.
			{ user_id: ORG, org_id: ORG, job_type: "PLAN", status: "SUCCESS", config_snapshot: {}, runner_id: R1 },
		]);

		await db.insert(runnerReleases).values({
			id: RELEASE_ID,
			version: RELEASE_VERSION,
			released_at: new Date(Date.UTC(2099, 0, 1)), // far future ⇒ newest
		});
	});

	afterAll(async () => {
		const db = getServiceDb();
		await db.delete(jobs).where(eq(jobs.org_id, ORG));
		await db.delete(runners).where(inArray(runners.id, RUNNER_IDS));
		await db.delete(runnerReleases).where(eq(runnerReleases.id, RELEASE_ID));
	});

	it("buckets QUEUED jobs by provider (provider-less ⇒ 'any', terminal excluded)", async () => {
		const after = await backlogByProvider();
		const delta = (k: string) => (after.get(k) ?? 0) - (baseBacklog.get(k) ?? 0);
		expect(delta("civo")).toBe(3); // 3 QUEUED civo; the SUCCESS civo is excluded
		expect(delta("hetzner")).toBe(1);
		expect(delta("any")).toBe(2); // provider-less lifecycle jobs
	});

	it("counts only ONLINE managed runners that can serve the provider (NULL=any)", async () => {
		const civoDelta =
			(await countManagedRunnersForProvider("civo")) - baseManagedCivo;
		// R1 (ONLINE,[civo]) + R2 (ONLINE,NULL) + R6 (ONLINE,[civo]).
		// Excluded: R3 (DRAINING), R4 ([hetzner]), R5 (self).
		expect(civoDelta).toBe(3);
	});

	it("maps managed runners by cloud_instance_id with status + busy", async () => {
		const m = await managedRunnersByInstance("civo");

		// Present: managed, has instance, supports civo (or NULL).
		expect(m.has(INST1)).toBe(true);
		expect(m.has(INST2)).toBe(true);
		expect(m.has(INST3)).toBe(true);
		// Absent: hetzner-only runner, self runner, and the instance-less R6.
		expect(m.has(INST4)).toBe(false);
		expect(m.has(INST5)).toBe(false);

		expect(m.get(INST1)).toMatchObject({
			runnerId: R1,
			status: "online",
			version: "1.2.3",
			busy: true, // has a CLAIMED job
		});
		expect(m.get(INST2)).toMatchObject({
			runnerId: R2,
			status: "online",
			busy: true, // has a PROCESSING job (NULL supported_providers still serves civo)
		});
		expect(m.get(INST3)).toMatchObject({
			runnerId: R3,
			status: "draining",
			busy: false, // idle
		});
	});

	it("does not surface civo runners under a non-matching provider", async () => {
		const m = await managedRunnersByInstance("gcp");
		// R1/R3/R6 are civo-only; only R2 (NULL=any) would match gcp.
		expect(m.has(INST1)).toBe(false);
		expect(m.has(INST3)).toBe(false);
		expect(m.has(INST2)).toBe(true);
	});

	it("enriches + orders managed runner rows newest-first for the Fleet view", async () => {
		const rows = await managedRunnerRowsForProvider("civo");
		const mine = rows.filter((r) => (RUNNER_IDS as string[]).includes(r.runnerId));

		// All managed civo-servers regardless of status: R1,R2,R3,R6. Not R4 (hetzner)
		// nor R5 (self). Ordered by created_at DESC ⇒ R6, R3, R2, R1.
		expect(mine.map((r) => r.runnerId)).toEqual([R6, R3, R2, R1]);

		const r1 = mine.find((r) => r.runnerId === R1);
		expect(r1).toMatchObject({
			instanceId: INST1,
			location: "fsn1",
			version: "1.2.3",
			status: "online",
			busy: true,
		});
		expect(typeof r1?.ageSeconds).toBe("number");
		expect(r1?.ageSeconds).toBeGreaterThan(0);
		expect(typeof r1?.lastSeenSeconds).toBe("number");

		// R6 never heartbeat ⇒ lastSeenSeconds null; instance-less ⇒ instanceId null.
		const r6 = mine.find((r) => r.runnerId === R6);
		expect(r6?.lastSeenSeconds).toBeNull();
		expect(r6?.instanceId).toBeNull();

		// R3 status maps DRAINING ⇒ "draining".
		expect(mine.find((r) => r.runnerId === R3)?.status).toBe("draining");
	});

	it("counts in-flight managed jobs for the provider (join + status + NULL=any)", async () => {
		const civoDelta =
			(await countInflightForProvider("civo")) - baseInflightCivo;
		// R1 CLAIMED + R2 PROCESSING. Excluded: R4 (hetzner runner), R5 (self runner),
		// R1's SUCCESS (terminal).
		expect(civoDelta).toBe(2);
	});

	it("returns the newest release version by released_at", async () => {
		expect(await latestReleaseVersion()).toBe(RELEASE_VERSION);
	});
});
