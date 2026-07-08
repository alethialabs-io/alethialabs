// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: the project-scoped usage queries against real Postgres — job-minutes filtered by
// project_id (vs org_id), the project resource counts, and the best-effort AI-credit attribution
// (ref_id → jobs.project_id for scans, ref_id → agent_threads.project_id for agents; support /
// unmatched rows excluded). Seeds via the service connection; cleans up by the per-test org id.

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { getServiceDb } from "@/lib/db";
import {
	aiCreditsSeriesByProject,
	sumCreditsByProject,
} from "@/lib/billing/ai-quota";
import {
	agentThreads,
	aiUsageLedger,
	jobs,
	projectCluster,
	projects,
	runners,
} from "@/lib/db/schema";
import {
	queryJobMinutesByProject,
	queryJobMinutesSeriesByProject,
} from "@/lib/queries/runner-usage";
import {
	queryProjectResourceCounts,
	queryProjectRunningJobs,
} from "@/lib/queries/usage-counts";
import { describeIfDb, seedManagedRunner } from "./db";

const ORG = randomUUID();
let runnerId: string;
let projectA: string;
let projectB: string;
let scanJobA: string;
let agentThreadA: string;

const d = (iso: string) => new Date(iso);

describeIfDb("project-usage queries", () => {
	beforeAll(async () => {
		const db = getServiceDb();
		runnerId = await seedManagedRunner(`it-projusage-${ORG.slice(0, 8)}`);

		const insertedProjects = await db
			.insert(projects)
			.values([
				{
					user_id: ORG,
					org_id: ORG,
					project_name: "proj-a",
					region: "eu-west-1",
					iac_version: "1.0.0",
					estimated_monthly_cost: 240,
				},
				{
					user_id: ORG,
					org_id: ORG,
					project_name: "proj-b",
					region: "eu-west-1",
					iac_version: "1.0.0",
					estimated_monthly_cost: 60,
				},
			])
			.returning({ id: projects.id });
		projectA = insertedProjects[0].id;
		projectB = insertedProjects[1].id;

		// Two clusters under A, none under B.
		await db.insert(projectCluster).values([
			{ project_id: projectA },
			{ project_id: projectA },
		]);

		// Project A: a 5-min completed managed job + a 30-min completed managed job on
		// different days, plus one in-flight job. Project B: one 10-min completed job.
		const insertedJobs = await db
			.insert(jobs)
			.values([
				{
					user_id: ORG,
					org_id: ORG,
					project_id: projectA,
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
					project_id: projectA,
					job_type: "PLAN",
					status: "SUCCESS",
					config_snapshot: {},
					runner_id: runnerId,
					started_at: d("2026-06-11T10:00:00Z"),
					completed_at: d("2026-06-11T10:30:00Z"),
				},
				{
					user_id: ORG,
					org_id: ORG,
					project_id: projectA,
					job_type: "PLAN",
					status: "PROCESSING",
					config_snapshot: {},
					runner_id: runnerId,
				},
				{
					user_id: ORG,
					org_id: ORG,
					project_id: projectB,
					job_type: "PLAN",
					status: "SUCCESS",
					config_snapshot: {},
					runner_id: runnerId,
					started_at: d("2026-06-10T12:00:00Z"),
					completed_at: d("2026-06-10T12:10:00Z"),
				},
			])
			.returning({ id: jobs.id, project_id: jobs.project_id });
		scanJobA = insertedJobs.find((j) => j.project_id === projectA)?.id ?? "";

		// An agent thread under project A (its id is an AI ledger ref for "agent" rows).
		const [thread] = await db
			.insert(agentThreads)
			.values({
				user_id: ORG,
				org_id: ORG,
				project_id: projectA,
				title: "it-thread",
			})
			.returning({ id: agentThreads.id });
		agentThreadA = thread.id;

		// AI ledger rows: a scan (ref = job A → project A), an agent (ref = thread A →
		// project A), and a support row with an unmatched ref (must NOT attribute to A).
		await db.insert(aiUsageLedger).values([
			{
				user_id: ORG,
				org_id: ORG,
				kind: "scan",
				credits: 12,
				source: "included",
				ref_id: scanJobA,
			},
			{
				user_id: ORG,
				org_id: ORG,
				kind: "agent",
				credits: 8,
				source: "included",
				ref_id: agentThreadA,
			},
			{
				user_id: ORG,
				org_id: ORG,
				kind: "support",
				credits: 100,
				source: "included",
				ref_id: randomUUID(),
			},
		]);
	});

	afterAll(async () => {
		const db = getServiceDb();
		await db.delete(aiUsageLedger).where(eq(aiUsageLedger.org_id, ORG));
		await db.delete(agentThreads).where(eq(agentThreads.org_id, ORG));
		await db.delete(jobs).where(eq(jobs.org_id, ORG));
		// project_cluster cascades when the projects are deleted.
		await db.delete(projects).where(eq(projects.org_id, ORG));
		await db.delete(runners).where(eq(runners.id, runnerId));
	});

	it("sums job-minutes for the project (not the whole org)", async () => {
		const a = await queryJobMinutesByProject(getServiceDb(), {
			from: d("2026-06-01T00:00:00Z"),
			to: d("2026-06-30T00:00:00Z"),
			projectId: projectA,
		});
		expect(a.job_minutes).toBeCloseTo(35); // 5 + 30 — B's 10 min excluded
		expect(a.job_count).toBe(2);

		const b = await queryJobMinutesByProject(getServiceDb(), {
			from: d("2026-06-01T00:00:00Z"),
			to: d("2026-06-30T00:00:00Z"),
			projectId: projectB,
		});
		expect(b.job_minutes).toBeCloseTo(10);
		expect(b.job_count).toBe(1);
	});

	it("buckets project job-minutes by completion day", async () => {
		const series = await queryJobMinutesSeriesByProject(getServiceDb(), {
			from: d("2026-06-01T00:00:00Z"),
			to: d("2026-06-30T00:00:00Z"),
			projectId: projectA,
		});
		const byDay = Object.fromEntries(series.map((r) => [r.day, r.job_minutes]));
		expect(byDay["2026-06-10"]).toBeCloseTo(5);
		expect(byDay["2026-06-11"]).toBeCloseTo(30);
	});

	it("counts clusters + reads estimated cost per project", async () => {
		const a = await queryProjectResourceCounts(projectA);
		expect(a.clusters).toBe(2);
		expect(a.estimatedMonthlyCost).toBeCloseTo(240);

		const b = await queryProjectResourceCounts(projectB);
		expect(b.clusters).toBe(0);
		expect(b.estimatedMonthlyCost).toBeCloseTo(60);
	});

	it("counts only in-flight jobs for the project concurrency gauge", async () => {
		expect(await queryProjectRunningJobs(projectA)).toBe(1); // the PROCESSING job
		expect(await queryProjectRunningJobs(projectB)).toBe(0);
	});

	it("attributes AI credits to the project via ref_id, excluding unmatched rows", async () => {
		// 12 (scan → job A) + 8 (agent → thread A) = 20; the 100-credit support row is excluded.
		const used = await sumCreditsByProject(projectA, "included", new Date(0));
		expect(used).toBe(20);
		// Project B spent no AI.
		expect(await sumCreditsByProject(projectB, "included", new Date(0))).toBe(0);
	});

	it("buckets project AI credits by day (best-effort attribution)", async () => {
		const series = await aiCreditsSeriesByProject(
			projectA,
			new Date(Date.now() - 7 * 24 * 3600 * 1000),
			new Date(Date.now() + 24 * 3600 * 1000),
		);
		const total = series.reduce((n, r) => n + r.credits, 0);
		expect(total).toBe(20); // support row's 100 credits not attributed to the project
	});
});
