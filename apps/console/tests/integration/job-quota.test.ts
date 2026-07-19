// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: the free-tier daily job quota (assertJobQuotaAllowed) against real Postgres.
// Proves the four load-bearing properties:
//   1. a community (free) org is allowed under the cap and blocked at it;
//   2. SYSTEM-initiated jobs (reconcile/drift/probe/...) NEVER count — the guarantee that the
//      quota can't throttle auto-reconcile;
//   3. the window is a trailing 24h (jobs older than 24h drop out of the count);
//   4. a paid (team) org is never capped.

import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { assertJobQuotaAllowed } from "@/lib/billing/job-quota";
import { UsageLimitError } from "@/lib/billing/usage-guard";
import { getServiceDb } from "@/lib/db";
import type { JobInitiator } from "@/lib/db/schema";
import { jobs, organization, organizationBilling } from "@/lib/db/schema";
import { describeIfDb } from "./db";

const FREE_ORG = randomUUID(); // no billing row → community (free)
const PAID_ORG = randomUUID(); // team plan → unbounded
const ORG_IDS = [FREE_ORG, PAID_ORG];

/** Insert one job for an org with a given origin, optionally aged into the past. */
async function insertJob(
	orgId: string,
	initiated_by: JobInitiator,
	agoMs = 0,
): Promise<void> {
	await getServiceDb()
		.insert(jobs)
		.values({
			// community org_id == user_id, so keeping them equal keeps the paid case consistent too.
			user_id: orgId,
			org_id: orgId,
			job_type: "PLAN",
			status: "QUEUED",
			config_snapshot: {},
			initiated_by,
			created_at: new Date(Date.now() - agoMs),
		});
}

describeIfDb("free-tier daily job quota", () => {
	beforeAll(async () => {
		const db = getServiceDb();
		// organization_billing FKs organization.id (cascade) → seed the org first.
		await db
			.insert(organization)
			.values({ id: PAID_ORG, name: `it-quota-paid-${PAID_ORG.slice(0, 6)}` });
		await db
			.insert(organizationBilling)
			.values({ organizationId: PAID_ORG, plan: "team", status: "active" });
	});

	afterEach(async () => {
		await getServiceDb().delete(jobs).where(inArray(jobs.org_id, ORG_IDS));
		vi.unstubAllEnvs();
	});

	afterAll(async () => {
		const db = getServiceDb();
		await db
			.delete(organizationBilling)
			.where(eq(organizationBilling.organizationId, PAID_ORG));
		await db.delete(organization).where(eq(organization.id, PAID_ORG));
	});

	it("allows a community org under the cap, blocks at the cap", async () => {
		vi.stubEnv("ALETHIA_FREE_DAILY_JOB_QUOTA", "3");
		await insertJob(FREE_ORG, "user");
		await insertJob(FREE_ORG, "user");
		// 2 < 3 → allowed.
		await expect(assertJobQuotaAllowed(FREE_ORG)).resolves.toBeUndefined();
		await insertJob(FREE_ORG, "user"); // now 3 in window
		await expect(assertJobQuotaAllowed(FREE_ORG)).rejects.toBeInstanceOf(
			UsageLimitError,
		);
	});

	it("never counts SYSTEM jobs against the quota (auto-reconcile is never throttled)", async () => {
		vi.stubEnv("ALETHIA_FREE_DAILY_JOB_QUOTA", "3");
		for (let i = 0; i < 10; i++) await insertJob(FREE_ORG, "system"); // far past cap
		await expect(assertJobQuotaAllowed(FREE_ORG)).resolves.toBeUndefined();
	});

	it("counts only the trailing 24h — jobs older than 24h drop out", async () => {
		vi.stubEnv("ALETHIA_FREE_DAILY_JOB_QUOTA", "2");
		const DAY_PLUS = 25 * 60 * 60 * 1000;
		await insertJob(FREE_ORG, "user", DAY_PLUS);
		await insertJob(FREE_ORG, "user", DAY_PLUS);
		await insertJob(FREE_ORG, "user", DAY_PLUS);
		// All 3 are older than 24h → 0 in window → allowed.
		await expect(assertJobQuotaAllowed(FREE_ORG)).resolves.toBeUndefined();
		await insertJob(FREE_ORG, "user");
		await insertJob(FREE_ORG, "user"); // 2 fresh → at cap
		await expect(assertJobQuotaAllowed(FREE_ORG)).rejects.toBeInstanceOf(
			UsageLimitError,
		);
	});

	it("never caps a paid (team) org", async () => {
		vi.stubEnv("ALETHIA_FREE_DAILY_JOB_QUOTA", "1");
		for (let i = 0; i < 5; i++) await insertJob(PAID_ORG, "user"); // well past a free cap
		await expect(assertJobQuotaAllowed(PAID_ORG)).resolves.toBeUndefined();
	});
});
