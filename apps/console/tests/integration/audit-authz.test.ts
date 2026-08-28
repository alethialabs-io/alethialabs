// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: `queueAudit` is gated by the REAL authorization stack — real authorize() → real
// getPdp() (community PostgresRbacPDP) → real permission/role/role_permission in Postgres (#2697).
//
// Before the fix the action called `currentActor()` and nothing else: identity, never permission.
// `projectId` went straight into the insert, and RLS on `jobs` is ORG-scoped, so its WITH CHECK
// passes for ANY project in the caller's org. A viewer — or the MODEL, via `audit_infrastructure`
// in lib/ai/tools/scanner.ts, whose schema exposes `projectId` as a free optional string — could
// attach an AUDIT job carrying attacker-chosen `audit_input` to a project they may only read, and
// its signed `verify_result` then renders in that project's feed.
//
// A MOCKED suite could only prove the gate is CALLED. This proves the PDP actually DENIES, which
// is the property that matters, and it proves it non-vacuously in three directions:
//
//   1. a viewer (project:view, NOT project:audit) is REFUSED and writes NO job row
//   2. an operator (project:audit) is ALLOWED — so the test cannot pass by denying everyone
//   3. the UNATTACHED path (no projectId) still works for the viewer — so the fix did not
//      quietly remove a legitimate capability while closing the hole
//
// Actor injected via the real `runWithActor` seam, the same one the MCP route uses, so the action
// runs unchanged under the test identity.

import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { queueAudit } from "@/app/server/actions/audit";
import { runWithActor } from "@/lib/authz/actor-context";
import { BUILTIN_ROLE_IDS } from "@/lib/authz/registry";
import { seedAuthz } from "@/lib/authz/seed";
import type { Actor, Entitlements } from "@/lib/authz/types";
import { ForbiddenError } from "@/lib/authz/types";
import { getServiceDb } from "@/lib/db";
import { grants, jobs, organization, projects, user } from "@/lib/db/schema";
import { describeIfDb } from "./db";

const ORG = randomUUID();
const OPERATOR = randomUUID(); // holds project:audit
const VIEWER = randomUUID(); // project:view only — NOT project:audit
const PROJECT = randomUUID();

// customRoles=true so the ENTITLEMENT gate always passes: whatever denial we observe is then the
// PDP refusing `project:audit`, which is the thing under test — not a licensing check standing in
// front of it and making the assertion pass for the wrong reason.
const ENTITLEMENTS: Entitlements = {
	organizations: true,
	teams: true,
	sso: true,
	customRoles: true,
	activityExport: true,
	alerting: true,
	advancedAlerting: true,
	byoRunners: true,
	managedPools: true,
	quotas: {
		maxConcurrentJobs: null,
		priorityLevel: 30,
		includedRunnerMinutes: 0,
		activityRetentionDays: 365,
	},
};

const actorFor = (userId: string): Actor => ({ userId, orgId: ORG, entitlements: ENTITLEMENTS });

async function seedRoleGrant(principalId: string, roleId: string): Promise<void> {
	await getServiceDb().insert(grants).values({
		org_id: ORG,
		principal_type: "user",
		principal_id: principalId,
		effect: "allow",
		role_id: roleId,
		resource_type: "org",
		resource_id: null,
	});
}

/** AUDIT jobs sitting on the fixture project — the thing an unauthorized caller must not create. */
async function auditJobsOnProject(): Promise<number> {
	const rows = await getServiceDb()
		.select({ id: jobs.id })
		.from(jobs)
		.where(eq(jobs.project_id, PROJECT));
	return rows.length;
}

describeIfDb("queueAudit — real PDP gate (#2697)", () => {
	beforeAll(async () => {
		const db = getServiceDb();
		await seedAuthz();
		await db.insert(user).values([
			{ id: OPERATOR, email: `it-audit-op-${OPERATOR}@example.test` },
			{ id: VIEWER, email: `it-audit-viewer-${VIEWER}@example.test` },
		]);
		await db.insert(organization).values({ id: ORG, name: `audit-${ORG.slice(0, 8)}` });
		await db.insert(projects).values({
			id: PROJECT,
			user_id: OPERATOR,
			org_id: ORG,
			project_name: `audit-target-${PROJECT.slice(0, 8)}`,
			region: "eu-west-1",
			iac_version: "1.0.0",
		});
		await seedRoleGrant(OPERATOR, BUILTIN_ROLE_IDS.operator);
		await seedRoleGrant(VIEWER, BUILTIN_ROLE_IDS.viewer);
	});

	beforeEach(async () => {
		await getServiceDb().delete(jobs).where(eq(jobs.project_id, PROJECT));
	});

	afterAll(async () => {
		const db = getServiceDb();
		await db.delete(jobs).where(eq(jobs.project_id, PROJECT));
		await db.delete(projects).where(eq(projects.id, PROJECT));
		await db.delete(grants).where(eq(grants.org_id, ORG));
		await db.delete(organization).where(eq(organization.id, ORG));
		await db.delete(user).where(inArray(user.id, [OPERATOR, VIEWER]));
	});

	// THE DEFECT. Pre-fix this resolves and the job lands on a project the viewer may only read.
	it("refuses a viewer who names a project they may not audit", async () => {
		await expect(
			runWithActor(actorFor(VIEWER), () => queueAudit("{}", "plan", PROJECT)),
		).rejects.toBeInstanceOf(ForbiddenError);
	});

	// A refusal that still wrote the row would be no refusal at all.
	it("...and writes no job row on the denied path", async () => {
		await expect(
			runWithActor(actorFor(VIEWER), () => queueAudit("{}", "plan", PROJECT)),
		).rejects.toThrow();
		expect(await auditJobsOnProject()).toBe(0);
	});

	// Without this the suite would pass just as well if authorize() denied EVERYONE.
	it("allows an operator, who holds project:audit", async () => {
		const { jobId } = await runWithActor(actorFor(OPERATOR), () =>
			queueAudit("{}", "plan", PROJECT),
		);
		expect(jobId).toBeTruthy();
		expect(await auditJobsOnProject()).toBe(1);
	});

	// The unattached audit is a legitimate capability — a plan that belongs to no project yet — and
	// closing the hole must not take it away. Identity alone is the correct bar when there is no
	// project id to authorize against.
	it("still allows an unattached audit, with no project to authorize against", async () => {
		const { jobId } = await runWithActor(actorFor(VIEWER), () => queueAudit("{}", "plan"));
		expect(jobId).toBeTruthy();
		// It attached to nothing, so the fixture project is still clean.
		expect(await auditJobsOnProject()).toBe(0);
		await getServiceDb().delete(jobs).where(eq(jobs.id, jobId));
	});
});
