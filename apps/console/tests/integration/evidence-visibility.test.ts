// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// EVIDENCE ROWS FOLLOW PROJECT VISIBILITY (#6126), against real Postgres and the edition's PDP.
//
// One org, two projects (P and Q), each with an environment that carries every kind of evidence — a
// verification verdict, a drift posture, a security posture and a recorded waiver — plus one
// org-level waiver (a job with no project and no environment). All authored by an admin who never
// reads. Two org viewers read through the `evidence.page` reader: VIEWER may view every project;
// DENIED holds an explicit deny on viewing P. The claim: a reader sees an environment's evidence —
// its row, its posture, its waivers, and its weight in the facet counts and the summary — exactly
// when they may view its project, and an org-level waiver is org-wide. VIEWER is the positive
// control: the same rows ARE there for a reader who may see them.
//
// It runs in whichever edition the job sets (CI: enterprise, the OpenFGA PDP), so every grant and
// hierarchy edge is written the way the app writes it: the Postgres row, then its tuple mirror. The
// reader runs under `runWithActor`, the binding the read router itself applies (lib/rpc/base.ts).

import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runWithActor } from "@/lib/authz/actor-context";
import { ensureMemberGrant } from "@/lib/authz/grants";
import { seedAuthz } from "@/lib/authz/seed";
import { getTupleSync } from "@/lib/authz/tuple-sync";
import { getServiceDb } from "@/lib/db";
import {
	authzActivityLog,
	environmentDrift,
	environmentSecurity,
	grants,
	jobs,
	member,
	organization,
	projectEnvironments,
	projects,
	resourceHierarchy,
	user,
} from "@/lib/db/schema";
import { editionState } from "@/lib/enterprise";
import { type EvidenceResult, readOrgEvidence } from "@/lib/rpc/procedures/evidence";
import type { VerifyOverrideInput, VerifyReport } from "@/types/jsonb.types";
import { describeIfDb, purgeAuthzActivityLog, seedJob } from "./db";

const ORG = randomUUID();
const ADMIN = randomUUID(); // authors every row; never reads
const VIEWER = randomUUID(); // may view every project
const DENIED = randomUUID(); // explicitly denied viewing project P
const USERS = [ADMIN, VIEWER, DENIED];
const P = randomUUID();
const Q = randomUUID();
const ENV_P = randomUUID();
const ENV_Q = randomUUID();
const seeded = { waiverP: "", waiverQ: "", waiverOrg: "" };

const REPORT: VerifyReport = {
	verdict: "fail",
	catalog_version: "elench-controls-0.1.0",
	provider: "aws",
	controls: [],
	summary: { pass: 0, fail: 1, warn: 0, not_evaluable: 0 },
};

/** A waiver in force for a week. */
function override(reason: string): VerifyOverrideInput {
	return {
		controls: ["KEYLESS-001"],
		reason,
		by: "admin@example.test",
		expiry: new Date(Date.now() + 7 * 86_400_000).toISOString(),
	};
}

/** Reads the evidence page as `userId` in the org, as the read router binds it. */
function readAs(userId: string): Promise<EvidenceResult> {
	return runWithActor({ userId, orgId: ORG }, () => readOrgEvidence({}));
}

/** The environment ids a result lists. */
function envIds(result: EvidenceResult): string[] {
	return result.groups.flatMap((g) => g.rows.map((r) => r.environmentId));
}

describeIfDb("evidence rows follow project visibility", () => {
	beforeAll(async () => {
		// The edition is a premise: a broken enterprise load must fail here rather than answer on the
		// community engine.
		const state = editionState();
		const expected = process.env.ALETHIA_EDITION === "enterprise" ? "enterprise" : "community";
		if (state.kind !== expected) {
			throw new Error(`the ${expected} edition did not load (${JSON.stringify(state)}); this suite would measure another engine`);
		}

		const db = getServiceDb();
		await seedAuthz();
		await db.insert(user).values(USERS.map((id) => ({ id, email: `it-6126-${id}@example.test` })));
		await db.insert(organization).values({ id: ORG, name: `it-6126-${ORG.slice(0, 8)}`, slug: `it-6126-${ORG.slice(0, 8)}` });
		await db.insert(member).values([
			{ organizationId: ORG, userId: ADMIN, role: "admin" },
			{ organizationId: ORG, userId: VIEWER, role: "viewer" },
			{ organizationId: ORG, userId: DENIED, role: "viewer" },
		]);
		await ensureMemberGrant(ORG, ADMIN, "admin");
		await ensureMemberGrant(ORG, VIEWER, "viewer");
		await ensureMemberGrant(ORG, DENIED, "viewer");
		await db.insert(projects).values(
			[P, Q].map((id) => ({
				id,
				user_id: ADMIN,
				org_id: ORG,
				project_name: `it-6126-${id.slice(0, 8)}`,
				region: "eu-west-1",
				iac_version: "1.0.0",
			})),
		);
		// The org → project edge creating a project writes, mirrored to the enterprise PDP's store.
		await db.insert(resourceHierarchy).values(
			[P, Q].map((id) => ({ child_type: "project", child_id: id, parent_type: "org", parent_id: ORG })),
		);
		for (const id of [P, Q]) {
			await getTupleSync().syncHierarchyEdge({ childType: "project", childId: id, parentType: "org", parentId: ORG });
		}
		// The explicit deny: DENIED may not view project P. The row, then its mirror.
		await db.insert(grants).values({
			org_id: ORG,
			principal_type: "user",
			principal_id: DENIED,
			effect: "deny",
			permission_key: "project:view",
			resource_type: "project",
			resource_id: P,
		});
		await getTupleSync().syncScopedGrant({
			orgId: ORG,
			principalType: "user",
			principalId: DENIED,
			effect: "deny",
			resourceType: "project",
			resourceId: P,
			roleId: null,
			permissionKey: "project:view",
		});

		await db.insert(projectEnvironments).values([
			{ id: ENV_P, project_id: P, user_id: ADMIN, name: "prod-p", stage: "production", is_default: true },
			{ id: ENV_Q, project_id: Q, user_id: ADMIN, name: "prod-q", stage: "production", is_default: true },
		]);
		for (const [project, env] of [
			[P, ENV_P],
			[Q, ENV_Q],
		]) {
			await seedJob(ADMIN, ORG, {
				project_id: project,
				environment_id: env,
				status: "SUCCESS",
				execution_metadata: { verify_result: REPORT },
			});
			await db.insert(environmentDrift).values({ project_id: project, environment_id: env, in_sync: false, drifted: 1 });
			await db.insert(environmentSecurity).values({
				project_id: project,
				environment_id: env,
				critical: 1,
				high: 0,
				medium: 0,
				low: 0,
				report_count: 1,
				scanned: true,
			});
		}
		seeded.waiverP = await seedJob(ADMIN, ORG, {
			project_id: P,
			environment_id: ENV_P,
			job_type: "DEPLOY",
			verify_override: override("waiver on P"),
		});
		seeded.waiverQ = await seedJob(ADMIN, ORG, {
			project_id: Q,
			environment_id: ENV_Q,
			job_type: "DEPLOY",
			verify_override: override("waiver on Q"),
		});
		seeded.waiverOrg = await seedJob(ADMIN, ORG, { job_type: "DEPLOY", verify_override: override("org-level") });
	});

	afterAll(async () => {
		const db = getServiceDb();
		await db.delete(jobs).where(eq(jobs.org_id, ORG));
		await db.delete(resourceHierarchy).where(eq(resourceHierarchy.parent_id, ORG));
		// Cascades the environments, drift and security rows.
		await db.delete(projects).where(eq(projects.org_id, ORG));
		await purgeAuthzActivityLog(inArray(authzActivityLog.org_id, [ORG]));
		await db.delete(grants).where(eq(grants.org_id, ORG));
		await db.delete(member).where(eq(member.organizationId, ORG));
		await db.delete(organization).where(eq(organization.id, ORG));
		await db.delete(user).where(inArray(user.id, USERS));
	});

	describe("a reader with an explicit deny on project P", () => {
		it("sees no environment of P — and still sees Q's", async () => {
			const result = await readAs(DENIED);
			expect(envIds(result)).not.toContain(ENV_P);
			expect(envIds(result)).toContain(ENV_Q);
			expect(result.groups.map((g) => g.label)).not.toContain(`it-6126-${P.slice(0, 8)}`);
		});

		it("sees no waiver of P; Q's and the org-level waiver remain", async () => {
			const waivers = (await readAs(DENIED)).waivers.map((w) => w.jobId);
			expect(waivers).not.toContain(seeded.waiverP);
			expect(waivers).toEqual(expect.arrayContaining([seeded.waiverQ, seeded.waiverOrg]));
		});

		it("P weighs nothing in the summary or the facet counts", async () => {
			const result = await readAs(DENIED);
			expect(result.total).toBe(1);
			expect(result.summary).toMatchObject({ environments: 1, failing: 1, drifted: 1, criticalHighVulns: 1 });
			expect(result.stageOptions).toEqual([{ value: "production", label: expect.any(String), count: 1 }]);
		});
	});

	describe("a reader who may view every project (the positive control)", () => {
		it("sees both environments, every waiver, and both in the counts", async () => {
			const result = await readAs(VIEWER);
			expect(envIds(result)).toEqual(expect.arrayContaining([ENV_P, ENV_Q]));
			expect(result.waivers.map((w) => w.jobId)).toEqual(
				expect.arrayContaining([seeded.waiverP, seeded.waiverQ, seeded.waiverOrg]),
			);
			expect(result.total).toBe(2);
			expect(result.summary).toMatchObject({ environments: 2, failing: 2, drifted: 2, criticalHighVulns: 2 });
		});
	});
});
