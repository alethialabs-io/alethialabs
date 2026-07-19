// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: the Teams co-member visibility contract that withActorScope() enables — the OTHER
// half of tenant isolation from rls.test.ts. rls.test.ts proves cross-ORG denial in the community
// shape (org_id === user_id, via withOwnerScope). This file proves the enterprise shape
// (org_id !== user_id): a teammate who did NOT create a row still SEES/So org-shared infra
// (projects, jobs, runners, project-child rows) through withActorScope — while a member of a
// DIFFERENT org still sees nothing. Under the old withOwnerScope(userId) the co-member reads
// would return empty (the bug this whole change fixes), so these assertions fail on the old path
// and pass on the new. Seeded via the service connection (RLS-bypassed); asserted through the
// RLS-enforced app connection. Skipped when the app role isn't distinct from the service role.

import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { getServiceDb, withActorScope, withOwnerScope } from "@/lib/db";
import { jobs, projectEnvironments, projects, runners } from "@/lib/db/schema";
import { describeIfDb } from "./db";

// One org, two DISTINCT members (M1 creates, M2 is the co-member who reads). A third member in a
// different org is the cross-tenant control.
const ORG = randomUUID();
const M1 = randomUUID();
const M2 = randomUUID();
const ORG_OTHER = randomUUID();
const M3 = randomUUID();

const APP_ROLE_DISTINCT =
	(process.env.ALETHIA_APP_DATABASE_URL ?? "") !== "" &&
	process.env.ALETHIA_APP_DATABASE_URL !== process.env.ALETHIA_DATABASE_URL;

let orgProjectId = "";
let otherProjectId = "";

describeIfDb("Teams co-member visibility (withActorScope)", () => {
	beforeAll(async () => {
		const db = getServiceDb();
		// M1 creates an org project; M3 creates a project in a different org.
		const [pOrg, pOther] = await db
			.insert(projects)
			.values([
				{
					user_id: M1,
					org_id: ORG,
					project_name: `org-${ORG.slice(0, 6)}`,
					region: "eu-west-1",
					iac_version: "1.0.0",
				},
				{
					user_id: M3,
					org_id: ORG_OTHER,
					project_name: `other-${ORG_OTHER.slice(0, 6)}`,
					region: "eu-west-1",
					iac_version: "1.0.0",
				},
			])
			.returning({ id: projects.id });
		orgProjectId = pOrg.id;
		otherProjectId = pOther.id;

		// A job (owner_all table) and a default environment (project-child table), both created by
		// M1 under ORG; and a self runner owned by M1 under ORG (managed runners have no owner).
		await db.insert(jobs).values([
			{ user_id: M1, org_id: ORG, job_type: "PLAN", project_id: orgProjectId },
			{ user_id: M3, org_id: ORG_OTHER, job_type: "PLAN", project_id: otherProjectId },
		]);
		await db.insert(projectEnvironments).values({
			project_id: orgProjectId,
			user_id: M1,
			org_id: ORG,
			name: "prod",
			is_default: true,
		});
		await db.insert(runners).values({
			operator: "self",
			provisioning: "registered", // self runners require provisioning (runners_provisioning_ck)
			user_id: M1,
			org_id: ORG,
			name: `r-${ORG.slice(0, 6)}`,
			token_hash: `h-${ORG.slice(0, 8)}`,
			status: "OFFLINE",
		});
	});

	afterAll(async () => {
		const db = getServiceDb();
		await db.delete(runners).where(inArray(runners.org_id, [ORG, ORG_OTHER]));
		await db
			.delete(projectEnvironments)
			.where(inArray(projectEnvironments.org_id, [ORG, ORG_OTHER]));
		await db.delete(jobs).where(inArray(jobs.org_id, [ORG, ORG_OTHER]));
		await db.delete(projects).where(inArray(projects.org_id, [ORG, ORG_OTHER]));
	});

	const M2_ACTOR = { userId: M2, orgId: ORG };
	const M3_ACTOR = { userId: M3, orgId: ORG_OTHER };

	// ── The broadening: a co-member sees org-shared rows they did NOT create ──────
	it.skipIf(!APP_ROLE_DISTINCT)(
		"co-member M2 sees M1's org project (invisible under the old withOwnerScope)",
		async () => {
			const viaActor = await withActorScope(M2_ACTOR, (tx) =>
				tx.select().from(projects).where(eq(projects.id, orgProjectId)),
			);
			expect(viaActor.map((p) => p.id)).toEqual([orgProjectId]);

			// Prove the OLD path was blind: M2's personal scope sees none of M1's org rows.
			const viaOwner = await withOwnerScope(M2, (tx) =>
				tx.select().from(projects).where(eq(projects.id, orgProjectId)),
			);
			expect(viaOwner).toHaveLength(0);
		},
	);

	it.skipIf(!APP_ROLE_DISTINCT)(
		"co-member M2 sees the org's jobs, project-child rows, and self runner",
		async () => {
			const [jobsSeen, envsSeen, runnersSeen] = await withActorScope(
				M2_ACTOR,
				async (tx) => [
					await tx.select().from(jobs).where(eq(jobs.project_id, orgProjectId)),
					await tx
						.select()
						.from(projectEnvironments)
						.where(eq(projectEnvironments.project_id, orgProjectId)),
					await tx.select().from(runners).where(eq(runners.org_id, ORG)),
				],
			);
			expect(jobsSeen).toHaveLength(1);
			expect(envsSeen).toHaveLength(1);
			expect(runnersSeen).toHaveLength(1);
		},
	);

	// ── Isolation still holds: another org's member sees none of it ───────────────
	it.skipIf(!APP_ROLE_DISTINCT)(
		"a different org's member (M3) sees none of ORG's rows",
		async () => {
			const [proj, job, env] = await withActorScope(M3_ACTOR, async (tx) => [
				await tx.select().from(projects).where(eq(projects.id, orgProjectId)),
				await tx.select().from(jobs).where(eq(jobs.project_id, orgProjectId)),
				await tx
					.select()
					.from(projectEnvironments)
					.where(eq(projectEnvironments.project_id, orgProjectId)),
			]);
			expect(proj).toHaveLength(0);
			expect(job).toHaveLength(0);
			expect(env).toHaveLength(0);
		},
	);

	// ── WITH CHECK: a teammate CAN create org work (org arm), not just the owner ──
	it.skipIf(!APP_ROLE_DISTINCT)(
		"co-member M2 can INSERT an org job (WITH CHECK passes via the org arm)",
		async () => {
			const inserted = await withActorScope(M2_ACTOR, (tx) =>
				tx
					.insert(jobs)
					.values({ user_id: M2, org_id: ORG, job_type: "PLAN", project_id: orgProjectId })
					.returning({ id: jobs.id, org_id: jobs.org_id }),
			);
			expect(inserted).toHaveLength(1);
			expect(inserted[0].org_id).toBe(ORG);

			// But M2 cannot insert a row destined for another org (WITH CHECK denies).
			await expect(
				withActorScope(M2_ACTOR, (tx) =>
					tx.insert(jobs).values({ user_id: M3, org_id: ORG_OTHER, job_type: "PLAN" }),
				),
			).rejects.toThrow();
		},
	);

	// Non-vacuity: the co-member wall is scoped to ORG, not "see everything".
	it.skipIf(!APP_ROLE_DISTINCT)(
		"co-member M2 does NOT see the other org's project",
		async () => {
			const leak = await withActorScope(M2_ACTOR, (tx) =>
				tx
					.select()
					.from(projects)
					.where(and(eq(projects.id, otherProjectId), eq(projects.org_id, ORG_OTHER))),
			);
			expect(leak).toHaveLength(0);
		},
	);
});
