// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: the runner-usage SQL against real Postgres — the clamp + day-bucket math and
// the managed-only / completed-only filters that mocks can't verify. Seeds via the service
// connection and cleans up by the per-test org id.

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { getServiceDb } from "@/lib/db";
import { jobs, runnerUsageSessions, runners } from "@/lib/db/schema";
import {
	queryJobMinutesByOrg,
	queryJobMinutesSeries,
	queryProvisionedHours,
} from "@/lib/queries/runner-usage";
import { describeIfDb, seedManagedRunner } from "./db";

const ORG = randomUUID();
let runnerId: string;

const d = (iso: string) => new Date(iso);

describeIfDb("runner-usage queries", () => {
	beforeAll(async () => {
		const db = getServiceDb();
		runnerId = await seedManagedRunner(`it-runner-${ORG.slice(0, 8)}`);
		// Two completed managed jobs on different days: 5 min + 30 min.
		await db.insert(jobs).values([
			{
				user_id: ORG,
				org_id: ORG,
				job_type: "PLAN",
				status: "SUCCESS",
				config_snapshot: {},
				runner_id: runnerId,
				started_at: d("2026-06-10T10:00:00Z"),
				completed_at: d("2026-06-10T10:05:00Z"),
			},
			{
				user_id: ORG,
				org_id: ORG,
				job_type: "PLAN",
				status: "SUCCESS",
				config_snapshot: {},
				runner_id: runnerId,
				started_at: d("2026-06-11T10:00:00Z"),
				completed_at: d("2026-06-11T10:30:00Z"),
			},
		]);
		// A provisioning session: 2 hours.
		await db.insert(runnerUsageSessions).values({
			runner_id: runnerId,
			operator: "managed",
			org_id: ORG,
			started_at: d("2026-06-10T00:00:00Z"),
			ended_at: d("2026-06-10T02:00:00Z"),
		});
	});

	afterAll(async () => {
		const db = getServiceDb();
		await db.delete(jobs).where(eq(jobs.org_id, ORG));
		await db.delete(runnerUsageSessions).where(eq(runnerUsageSessions.org_id, ORG));
		await db.delete(runners).where(eq(runners.id, runnerId));
	});

	it("sums job-minutes for the org over the window", async () => {
		const rows = await queryJobMinutesByOrg(getServiceDb(), {
			from: d("2026-06-01T00:00:00Z"),
			to: d("2026-06-30T00:00:00Z"),
			orgId: ORG,
		});
		expect(rows[0]?.job_minutes).toBeCloseTo(35);
		expect(rows[0]?.job_count).toBe(2);
	});

	it("excludes jobs completed outside the window", async () => {
		const rows = await queryJobMinutesByOrg(getServiceDb(), {
			from: d("2026-06-11T00:00:00Z"),
			to: d("2026-06-30T00:00:00Z"),
			orgId: ORG,
		});
		expect(rows[0]?.job_minutes).toBeCloseTo(30); // only the 06-11 job
	});

	it("buckets job-minutes by completion day", async () => {
		const series = await queryJobMinutesSeries(getServiceDb(), {
			from: d("2026-06-01T00:00:00Z"),
			to: d("2026-06-30T00:00:00Z"),
			orgId: ORG,
		});
		const byDay = Object.fromEntries(series.map((r) => [r.day, r.job_minutes]));
		expect(byDay["2026-06-10"]).toBeCloseTo(5);
		expect(byDay["2026-06-11"]).toBeCloseTo(30);
	});

	it("clamps provisioned hours to the window", async () => {
		const rows = await queryProvisionedHours(getServiceDb(), {
			from: d("2026-06-10T01:00:00Z"), // starts mid-session → 1h of the 2h counts
			to: d("2026-06-30T00:00:00Z"),
			orgId: ORG,
		});
		expect(rows[0]?.provisioned_hours).toBeCloseTo(1);
	});
});
