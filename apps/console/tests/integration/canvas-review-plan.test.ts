// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// THE REVIEW PLAN (#6831), against real Postgres and the edition's PDP.
//
// tests/lib/rpc/canvas-review-plan.test.ts pins the staleness rule and the read's shape over a
// stubbed database. This file runs the read's own queries: the design revision "as of the plan job"
// is compared inside the database, which a stub cannot show. One environment is walked through the
// sequence the board produces, in order, and each step reads the plan again:
// no plan → save, plan → save → plan → deploy.
//
// The steps share state and run in file order. Every row carries an explicit timestamp, a few
// seconds apart, so no step depends on how fast the previous one ran.

import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { runWithActor } from "@/lib/authz/actor-context";
import { ensureMemberGrant } from "@/lib/authz/grants";
import { seedAuthz } from "@/lib/authz/seed";
import { getTupleSync } from "@/lib/authz/tuple-sync";
import { getServiceDb } from "@/lib/db";
import {
	auditLog,
	authzActivityLog,
	environmentCost,
	grants,
	jobs,
	member,
	organization,
	projectEnvironments,
	projects,
	resourceHierarchy,
	user,
} from "@/lib/db/schema";
import { readReviewPlan } from "@/lib/rpc/procedures/canvas";
import type { SignedReceipt } from "@/types/jsonb.types";
import { describeIfDb, purgeAuthzActivityLog, seedJob } from "./db";

const ORG = randomUUID();
const ADMIN = randomUUID();
const P = randomUUID();
const SLUG = `it-6831-${P.slice(0, 8)}`;
const DIGEST = "d00afee3a0a1aa46d3814c234df364d0ffee658def91126693e00cea6ab0f0c9";
const START = Date.now() - 3_600_000;
let env = "";

/** The instant `seconds` after the sequence began. */
function at(seconds: number): Date {
	return new Date(START + seconds * 1000);
}

/** The plan job's verify receipt: only `plan_sha256` is read here. */
const RECEIPT: SignedReceipt = {
	algorithm: "none",
	receipt: {
		version: "1",
		plan_sha256: DIGEST,
		catalog_version: "elench-controls-0.1.0",
		provider: "aws",
		verdict: "pass",
		report: {
			verdict: "pass",
			catalog_version: "elench-controls-0.1.0",
			provider: "aws",
			controls: [],
			summary: { pass: 0, fail: 0, warn: 0, not_evaluable: 0 },
		},
	},
};

/** Records one audit row of the project and answers its id as a revision. */
async function audit(action: "UPDATED" | "PROVISIONED", seconds: number): Promise<string> {
	const [row] = await getServiceDb()
		.insert(auditLog)
		.values({ project_id: P, user_id: ADMIN, action, created_at: at(seconds) })
		.returning({ id: auditLog.id });
	return String(row.id);
}

/** Queues one finished job of the environment at `seconds`. */
function job(type: "PLAN" | "DEPLOY", seconds: number): Promise<string> {
	return seedJob(ADMIN, ORG, {
		project_id: P,
		environment_id: env,
		job_type: type,
		status: "SUCCESS",
		created_at: at(seconds),
		...(type === "PLAN"
			? {
					execution_metadata: {
						plan_result: {
							resource_changes: [
								{ address: "aws_vpc.this", type: "aws_vpc", name: "this", change: { actions: ["create"] } },
							],
						},
						verify_receipt: RECEIPT,
					},
				}
			: {}),
	});
}

/** The read, as the admin, as the read router binds it. */
function review() {
	return runWithActor({ userId: ADMIN, orgId: ORG, credential: "session" }, () => readReviewPlan(P, null));
}

let firstSave = "";
let firstPlan = "";
let secondSave = "";
let secondPlan = "";

describeIfDb("canvas.reviewPlan over one environment's save, plan and deploy (#6831)", () => {
	beforeAll(async () => {
		const db = getServiceDb();
		await seedAuthz();
		await db.insert(user).values({ id: ADMIN, email: `it-6831-${ADMIN}@example.test` });
		await db.insert(organization).values({ id: ORG, name: `it-6831-${ORG.slice(0, 8)}`, slug: `it-6831-${ORG.slice(0, 8)}` });
		await db.insert(member).values({ organizationId: ORG, userId: ADMIN, role: "admin" });
		await ensureMemberGrant(ORG, ADMIN, "admin");
		await db.insert(projects).values({
			id: P,
			user_id: ADMIN,
			org_id: ORG,
			project_name: SLUG,
			slug: SLUG,
			region: "eu-west-1",
			iac_version: "1.0.0",
		});
		const [e] = await db
			.insert(projectEnvironments)
			.values({ project_id: P, user_id: ADMIN, org_id: ORG, name: "dev", status: "DRAFT", is_default: true })
			.returning({ id: projectEnvironments.id });
		env = e.id;
		await db.insert(resourceHierarchy).values({ child_type: "project", child_id: P, parent_type: "org", parent_id: ORG });
		await getTupleSync().syncHierarchyEdge({ childType: "project", childId: P, parentType: "org", parentId: ORG });
	});

	afterAll(async () => {
		const db = getServiceDb();
		// Jobs keep their row when the project goes (on delete set null), so they go first.
		await db.delete(jobs).where(eq(jobs.org_id, ORG));
		await db.delete(resourceHierarchy).where(eq(resourceHierarchy.parent_id, ORG));
		await db.delete(projects).where(eq(projects.org_id, ORG)); // cascades the environment, cost and audit rows
		await purgeAuthzActivityLog(inArray(authzActivityLog.org_id, [ORG]));
		await db.delete(grants).where(eq(grants.org_id, ORG));
		await db.delete(member).where(eq(member.organizationId, ORG));
		await db.delete(organization).where(eq(organization.id, ORG));
		await db.delete(user).where(eq(user.id, ADMIN));
	});

	it("an environment that was never planned has no plan to deploy", async () => {
		expect(await review()).toEqual({
			environmentId: env,
			planJobId: null,
			status: null,
			createdAt: null,
			summary: null,
			cost: null,
			designRevision: null,
			savedRevision: "0",
			digest: null,
			current: false,
			staleReason: "no-plan",
		});
	});

	it("a plan queued after a save is current, and carries its job id, revision and digest", async () => {
		firstSave = await audit("UPDATED", 10);
		firstPlan = await job("PLAN", 20);
		await getServiceDb().insert(environmentCost).values({
			project_id: P,
			environment_id: env,
			plan_job_id: firstPlan,
			total_monthly: 212.4,
			currency: "EUR",
		});
		expect(await review()).toEqual({
			environmentId: env,
			planJobId: firstPlan,
			status: "SUCCESS",
			createdAt: at(20).toISOString(),
			summary: { create: 1, update: 0, delete: 0, replace: 0 },
			cost: { totalMonthly: 212.4, currency: "EUR" },
			designRevision: firstSave,
			savedRevision: firstSave,
			digest: DIGEST,
			current: true,
			staleReason: null,
		});
	});

	it("a save after the plan makes it stale: the plan keeps the revision it was queued at", async () => {
		secondSave = await audit("UPDATED", 30);
		expect(Number(secondSave)).toBeGreaterThan(Number(firstSave));
		expect(await review()).toMatchObject({
			planJobId: firstPlan,
			designRevision: firstSave,
			savedRevision: secondSave,
			current: false,
			staleReason: "design-changed",
		});
	});

	it("a new plan of the saved design is the current one, and is priced on its own", async () => {
		secondPlan = await job("PLAN", 40);
		expect(await review()).toMatchObject({
			planJobId: secondPlan,
			designRevision: secondSave,
			savedRevision: secondSave,
			// The first plan's price is not this plan's.
			cost: null,
			current: true,
			staleReason: null,
		});
	});

	it("a deploy queued after the plan makes it stale, and its audit row is not a design write", async () => {
		await job("DEPLOY", 50);
		await audit("PROVISIONED", 50);
		expect(await review()).toMatchObject({
			planJobId: secondPlan,
			designRevision: secondSave,
			savedRevision: secondSave,
			current: false,
			staleReason: "run-since-plan",
		});
	});
});
