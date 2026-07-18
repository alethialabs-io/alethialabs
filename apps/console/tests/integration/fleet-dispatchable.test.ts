// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: dispatchableBacklogByProvider() against real Postgres — the cap-aware backlog that
// SIZES the fleet. Proves the core fix: a community org's QUEUED jobs beyond its 2-concurrency cap
// do NOT inflate the dispatchable count (so the scaler stops provisioning VMs the caps block), while
// raw backlogByProvider() still counts them all. Also pins plan_max_concurrency's per-plan values.
// Seeds via getServiceDb() (bypasses RLS) with unique ids; global-scope counts are asserted as
// DELTAS against a baseline captured before seeding, on a rarely-used provider, so concurrent dev-DB
// rows can't perturb the assertions.

import { randomUUID } from "node:crypto";
import { inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { getServiceDb } from "@/lib/db";
import { jobs, runners } from "@/lib/db/schema";
import {
	backlogByProvider,
	dispatchableBacklogByProvider,
} from "@/lib/fleet/queue";
import { describeIfDb } from "./db";

// Three community orgs (no organization_billing row ⇒ org_effective_plan falls back to community,
// cap = 2). Distinct in-flight so each has different remaining headroom.
const ORG_A = randomUUID(); // 2 in-flight (at cap) → headroom 0 → contributes 0 of its 5 queued
const ORG_B = randomUUID(); // 1 in-flight          → headroom 1 → contributes 1 of its 5 queued
const ORG_C = randomUUID(); // 0 in-flight          → headroom 2 → contributes 2 of its 5 queued
const ORG_IDS = [ORG_A, ORG_B, ORG_C];

const RUN = randomUUID(); // one managed ONLINE runner the in-flight jobs join through
const PROVIDER = "alibaba"; // rarely used on the dev DB → the delta is effectively ours alone

const inflight = (org: string, status: "CLAIMED" | "PROCESSING") => ({
	user_id: org,
	org_id: org,
	job_type: "PLAN" as const,
	status,
	config_snapshot: {},
	provider: PROVIDER as "alibaba",
	runner_id: RUN,
});
const queued = (org: string) => ({
	user_id: org,
	org_id: org,
	job_type: "PLAN" as const,
	status: "QUEUED" as const,
	config_snapshot: {},
	provider: PROVIDER as "alibaba",
});

let rawBefore = 0;
let dispBefore = 0;

describeIfDb("dispatchableBacklogByProvider — cap-aware fleet demand", () => {
	beforeAll(async () => {
		const db = getServiceDb();
		rawBefore = (await backlogByProvider()).get(PROVIDER) ?? 0;
		dispBefore = (await dispatchableBacklogByProvider()).get(PROVIDER) ?? 0;

		await db.insert(runners).values({
			id: RUN,
			name: `it-disp-run-${RUN.slice(0, 8)}`,
			operator: "managed",
			token_hash: `h-${RUN}`,
			status: "ONLINE",
			supported_providers: [PROVIDER],
		});

		await db.insert(jobs).values([
			// ORG_A: 2 in-flight (at the community cap) + 5 queued
			inflight(ORG_A, "CLAIMED"),
			inflight(ORG_A, "PROCESSING"),
			...Array.from({ length: 5 }, () => queued(ORG_A)),
			// ORG_B: 1 in-flight + 5 queued
			inflight(ORG_B, "CLAIMED"),
			...Array.from({ length: 5 }, () => queued(ORG_B)),
			// ORG_C: 0 in-flight + 5 queued
			...Array.from({ length: 5 }, () => queued(ORG_C)),
		]);
	});

	afterAll(async () => {
		const db = getServiceDb();
		await db.delete(jobs).where(inArray(jobs.org_id, ORG_IDS));
		await db.delete(runners).where(inArray(runners.id, [RUN]));
	});

	it("raw backlog counts every QUEUED job (cap-blind): +15", async () => {
		const raw = (await backlogByProvider()).get(PROVIDER) ?? 0;
		expect(raw - rawBefore).toBe(15); // 5 + 5 + 5
	});

	it("dispatchable backlog counts only claimable-now jobs (cap-aware): +3", async () => {
		const disp = (await dispatchableBacklogByProvider()).get(PROVIDER) ?? 0;
		// ORG_A headroom 0 → 0, ORG_B headroom 1 → 1, ORG_C headroom 2 → 2
		expect(disp - dispBefore).toBe(3);
	});

	it("plan_max_concurrency pins the per-plan caps (community 2 / team 8 / enterprise unlimited)", async () => {
		const rows = await getServiceDb().execute<{
			community: number;
			team: number;
			enterprise: number | null;
		}>(sql`select
			public.plan_max_concurrency('community') as community,
			public.plan_max_concurrency('team') as team,
			public.plan_max_concurrency('enterprise') as enterprise`);
		expect(Number(rows[0].community)).toBe(2);
		expect(Number(rows[0].team)).toBe(8);
		expect(rows[0].enterprise).toBeNull();
	});
});
