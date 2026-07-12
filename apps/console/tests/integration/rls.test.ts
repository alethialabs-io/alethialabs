// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: row-level-security isolation — the multi-tenant blast wall. Seeded via the
// service connection (bypasses RLS); read/written back through the RLS-enforced app connection
// (withOwnerScope) to prove one org can never see OR mutate another's rows. Covers both the
// READ side (USING) and the WRITE side (WITH CHECK) across `projects` and `jobs` — the two
// owner-scoped tables the `owner_all` policy protects (lib/db/programmables.sql). Skips the
// isolation assertions when the app role isn't distinct from the service role (single-role dev).

import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { getServiceDb, withOwnerScope } from "@/lib/db";
import { jobs, projects } from "@/lib/db/schema";
import { describeIfDb } from "./db";

const ORG_A = randomUUID();
const ORG_B = randomUUID();

// The app role is only a real RLS boundary when it differs from the service role.
const APP_ROLE_DISTINCT =
	(process.env.ALETHIA_APP_DATABASE_URL ?? "") !== "" &&
	process.env.ALETHIA_APP_DATABASE_URL !== process.env.ALETHIA_DATABASE_URL;

describeIfDb("RLS tenant isolation", () => {
	beforeAll(async () => {
		const db = getServiceDb();
		await db.insert(projects).values([
			{
				user_id: ORG_A,
				org_id: ORG_A,
				project_name: `a-${ORG_A.slice(0, 6)}`,
				region: "eu-west-1",
				iac_version: "1.0.0",
			},
			{
				user_id: ORG_B,
				org_id: ORG_B,
				project_name: `b-${ORG_B.slice(0, 6)}`,
				region: "eu-west-1",
				iac_version: "1.0.0",
			},
		]);
		// One job per org (the second owner-scoped table under the owner_all policy).
		await db.insert(jobs).values([
			{ user_id: ORG_A, org_id: ORG_A, job_type: "PLAN" },
			{ user_id: ORG_B, org_id: ORG_B, job_type: "PLAN" },
		]);
	});

	afterAll(async () => {
		const db = getServiceDb();
		await db.delete(jobs).where(inArray(jobs.org_id, [ORG_A, ORG_B]));
		await db.delete(projects).where(inArray(projects.org_id, [ORG_A, ORG_B]));
	});

	it("the service connection sees both orgs' rows (RLS bypassed)", async () => {
		const rows = await getServiceDb()
			.select()
			.from(projects)
			.where(inArray(projects.org_id, [ORG_A, ORG_B]));
		expect(rows).toHaveLength(2);
	});

	// ── READ isolation (the USING clause) ──────────────────────────────────────
	it.skipIf(!APP_ROLE_DISTINCT)(
		"org A's app connection sees only org A's rows (projects + jobs)",
		async () => {
			const aProjects = await withOwnerScope(ORG_A, (tx) =>
				tx.select().from(projects).where(inArray(projects.org_id, [ORG_A, ORG_B])),
			);
			expect(aProjects.map((p) => p.org_id)).toEqual([ORG_A]);

			// Org A scope must NOT be able to read org B's row, even by asking for it.
			const leak = await withOwnerScope(ORG_A, (tx) =>
				tx.select().from(projects).where(eq(projects.org_id, ORG_B)),
			);
			expect(leak).toHaveLength(0);

			// Same wall on the jobs table.
			const aJobs = await withOwnerScope(ORG_A, (tx) =>
				tx.select().from(jobs).where(inArray(jobs.org_id, [ORG_A, ORG_B])),
			);
			expect(aJobs.map((j) => j.org_id)).toEqual([ORG_A]);
			const jobLeak = await withOwnerScope(ORG_A, (tx) =>
				tx.select().from(jobs).where(eq(jobs.org_id, ORG_B)),
			);
			expect(jobLeak).toHaveLength(0);
		},
	);

	// ── WRITE isolation (the WITH CHECK clause) ────────────────────────────────
	it.skipIf(!APP_ROLE_DISTINCT)(
		"org A cannot INSERT a row destined for org B (WITH CHECK denies)",
		async () => {
			// A project row whose tenancy (user_id/org_id) is org B, attempted from org A's
			// scope, violates WITH CHECK (user_id=current_owner OR org_id=current_org) → rejects.
			await expect(
				withOwnerScope(ORG_A, (tx) =>
					tx.insert(projects).values({
						user_id: ORG_B,
						org_id: ORG_B,
						project_name: `evil-${randomUUID().slice(0, 6)}`,
						region: "eu-west-1",
						iac_version: "1.0.0",
					}),
				),
			).rejects.toThrow();

			// And the same for jobs.
			await expect(
				withOwnerScope(ORG_A, (tx) =>
					tx.insert(jobs).values({ user_id: ORG_B, org_id: ORG_B, job_type: "PLAN" }),
				),
			).rejects.toThrow();

			// Nothing leaked in: org B still owns exactly its one seeded project.
			const bProjects = await getServiceDb()
				.select()
				.from(projects)
				.where(eq(projects.org_id, ORG_B));
			expect(bProjects).toHaveLength(1);
		},
	);

	it.skipIf(!APP_ROLE_DISTINCT)(
		"org A cannot UPDATE or DELETE org B's rows (USING hides them → 0 affected)",
		async () => {
			// UPDATE of org B's project from org A's scope matches no rows (RLS-invisible).
			const updated = await withOwnerScope(ORG_A, (tx) =>
				tx
					.update(projects)
					.set({ project_name: "hijacked" })
					.where(eq(projects.org_id, ORG_B))
					.returning({ id: projects.id }),
			);
			expect(updated).toHaveLength(0);

			// DELETE likewise affects nothing.
			const deleted = await withOwnerScope(ORG_A, (tx) =>
				tx.delete(jobs).where(eq(jobs.org_id, ORG_B)).returning({ id: jobs.id }),
			);
			expect(deleted).toHaveLength(0);

			// Verify via the service connection: org B's rows are untouched and intact.
			const bProject = await getServiceDb()
				.select()
				.from(projects)
				.where(eq(projects.org_id, ORG_B));
			expect(bProject).toHaveLength(1);
			expect(bProject[0].project_name).not.toBe("hijacked");
			const bJob = await getServiceDb()
				.select()
				.from(jobs)
				.where(eq(jobs.org_id, ORG_B));
			expect(bJob).toHaveLength(1);
		},
	);

	// Non-vacuity control: within its OWN scope, org A can read + update its rows — the wall
	// blocks cross-tenant access, not all access (else the deny assertions would be trivial).
	it.skipIf(!APP_ROLE_DISTINCT)(
		"org A CAN read and update its own rows (the wall is not blocking everything)",
		async () => {
			const own = await withOwnerScope(ORG_A, (tx) =>
				tx
					.update(projects)
					.set({ iac_version: "1.0.1" })
					.where(and(eq(projects.org_id, ORG_A), eq(projects.user_id, ORG_A)))
					.returning({ id: projects.id }),
			);
			expect(own).toHaveLength(1);
		},
	);
});
