// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: a job the console refuses AT CLAIM fails the way a runner-reported failure does —
// against real Postgres, the real claim_next_job, the real env-status CAS and the real promotion
// lookup (lib/jobs/job-failed.ts).
//
// Setting jobs.status alone left the environment QUEUED, raised no alert, and — for a promotion's
// DEPLOY — left the promotion DEPLOYING, holding its target's one-active-promotion slot, so the
// redeploy the refusal asks for could not be started. For both claim-time refusals (a DEPLOY with an
// OCI BYO chart to a runner without the BYO marker capability, and a snapshot whose signature does not
// verify) this pins: the job FAILED with its reason, the environment FAILED, the promotion FAILED and
// a new promotion into the target accepted, and the `system.job.failed` alert raised.

import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { describeIfDb } from "./db";

const emitAlertEventSafe = vi.fn();
vi.mock("@/lib/alerts/emit", () => ({
	emitAlertEventSafe: (...args: unknown[]) => emitAlertEventSafe(...args),
}));
// The signature check is real crypto with a key the suite may not configure; it is driven here so the
// signature-mismatch refusal can be reached. Everything after it is real.
const verifySnapshot = vi.fn<(...args: unknown[]) => boolean>(() => true);
vi.mock("@/lib/runners/snapshot-sig", () => ({
	verifySnapshot: (...args: unknown[]) => verifySnapshot(...args),
}));

import { POST as claimPost } from "@/app/api/jobs/claim/route";
import { getServiceDb } from "@/lib/db";
import {
	environmentPromotions,
	jobs,
	projectEnvironments,
	projects,
	runners,
} from "@/lib/db/schema";
import { hashRunnerToken } from "@/lib/runners/auth";

const USER = randomUUID();
const ORG = randomUUID();
const TOKEN = `it-claim-refusal-${randomUUID()}`;
let runnerId = "";
const projectIds: string[] = [];

/** The snapshot of a DEPLOY that carries an OCI bring-your-own chart. */
const OCI_BYO_SNAPSHOT = {
	project_name: "acme",
	addons: [
		{ id: "payments", source: "helm", byo: true, chartRepo: "oci://ghcr.io/acme", chart: "payments", namespace: "byo-payments" },
	],
};

/**
 * Seeds a project with a source env and a QUEUED target env, a PLAN that backs a promotion into the
 * target, the promotion in DEPLOYING, and the promotion's DEPLOY job QUEUED for this file's runner.
 */
async function seedPromotionDeploy(snapshot: Record<string, unknown>) {
	const db = getServiceDb();
	const [p] = await db
		.insert(projects)
		.values({ user_id: USER, org_id: ORG, project_name: `it-refusal-${randomUUID().slice(0, 8)}`, region: "us-east-1", iac_version: "1.9.5" })
		.returning({ id: projects.id });
	projectIds.push(p.id);
	const [source] = await db
		.insert(projectEnvironments)
		.values({ project_id: p.id, user_id: USER, name: "dev", status: "ACTIVE", is_default: true })
		.returning({ id: projectEnvironments.id });
	const [target] = await db
		.insert(projectEnvironments)
		.values({ project_id: p.id, user_id: USER, name: "prod", status: "QUEUED", is_default: false })
		.returning({ id: projectEnvironments.id });
	const [plan] = await db
		.insert(jobs)
		.values({ user_id: USER, org_id: ORG, project_id: p.id, environment_id: target.id, job_type: "PLAN", status: "SUCCESS" })
		.returning({ id: jobs.id });
	const [deploy] = await db
		.insert(jobs)
		.values({
			user_id: USER,
			org_id: ORG,
			project_id: p.id,
			environment_id: target.id,
			job_type: "DEPLOY",
			status: "QUEUED",
			assigned_runner_id: runnerId,
			config_snapshot: snapshot,
		})
		.returning({ id: jobs.id });
	const [promotion] = await db
		.insert(environmentPromotions)
		.values({
			project_id: p.id,
			user_id: USER,
			org_id: ORG,
			source_environment_id: source.id,
			target_environment_id: target.id,
			plan_job_id: plan.id,
			deploy_job_id: deploy.id,
			status: "DEPLOYING",
		})
		.returning({ id: environmentPromotions.id });
	return { projectId: p.id, sourceId: source.id, targetId: target.id, planId: plan.id, deployId: deploy.id, promotionId: promotion.id };
}

/** Claims as this file's runner (no capability header: a runner built before the BYO marker). */
async function claim() {
	const res = await claimPost(
		new Request("https://console.local/api/jobs/claim", {
			method: "POST",
			headers: { "X-Runner-ID": runnerId, "X-Runner-Token": TOKEN },
		}),
	);
	return { status: res.status, text: await res.text() };
}

/** The end state the claim left behind. */
async function endState(seeded: Awaited<ReturnType<typeof seedPromotionDeploy>>) {
	const db = getServiceDb();
	const [job] = await db.select({ status: jobs.status, error: jobs.error_message }).from(jobs).where(eq(jobs.id, seeded.deployId));
	const [env] = await db.select({ status: projectEnvironments.status }).from(projectEnvironments).where(eq(projectEnvironments.id, seeded.targetId));
	const [promotion] = await db
		.select({ status: environmentPromotions.status })
		.from(environmentPromotions)
		.where(eq(environmentPromotions.id, seeded.promotionId));
	return { job, env, promotion };
}

/** A new promotion into the same target is accepted once the failed one released the slot. */
async function anotherPromotionIsAccepted(seeded: Awaited<ReturnType<typeof seedPromotionDeploy>>) {
	const [next] = await getServiceDb()
		.insert(environmentPromotions)
		.values({
			project_id: seeded.projectId,
			user_id: USER,
			org_id: ORG,
			source_environment_id: seeded.sourceId,
			target_environment_id: seeded.targetId,
			plan_job_id: seeded.planId,
			status: "PENDING_PLAN",
		})
		.returning({ id: environmentPromotions.id });
	return Boolean(next?.id);
}

describeIfDb("a claim-time refusal fails the job like a runner-reported failure", () => {
	beforeAll(async () => {
		const [r] = await getServiceDb()
			.insert(runners)
			.values({
				user_id: USER,
				org_id: ORG,
				name: `it-claim-refusal-${ORG.slice(0, 8)}`,
				operator: "self",
				provisioning: "registered",
				token_hash: hashRunnerToken(TOKEN),
				status: "ONLINE",
			})
			.returning({ id: runners.id });
		runnerId = r.id;
	});

	afterAll(async () => {
		const db = getServiceDb();
		await db.delete(jobs).where(eq(jobs.user_id, USER));
		if (projectIds.length) await db.delete(projects).where(inArray(projects.id, projectIds));
		await db.delete(runners).where(eq(runners.user_id, USER));
	});

	beforeEach(() => {
		emitAlertEventSafe.mockClear();
		verifySnapshot.mockReturnValue(true);
	});

	it("an OCI BYO DEPLOY refused to a runner without the marker: job, environment and promotion FAILED, alert raised", async () => {
		const seeded = await seedPromotionDeploy(OCI_BYO_SNAPSHOT);
		const { status, text } = await claim();
		expect(status).toBe(409);
		expect(text).toMatch(/bring-your-own OCI chart/);

		const after = await endState(seeded);
		expect(after.job.status).toBe("FAILED");
		expect(after.job.error).toMatch(/Update the runner/);
		expect(after.env.status).toBe("FAILED");
		expect(after.promotion.status).toBe("FAILED");
		expect(await anotherPromotionIsAccepted(seeded)).toBe(true);
		expect(emitAlertEventSafe).toHaveBeenCalledWith(
			ORG,
			"system.job.failed",
			expect.objectContaining({ job_id: seeded.deployId, job_type: "DEPLOY", severity: "critical" }),
		);
	});

	it("a snapshot whose signature does not verify: the same end state", async () => {
		verifySnapshot.mockReturnValue(false);
		const seeded = await seedPromotionDeploy({ project_name: "acme" });
		const { status } = await claim();
		expect(status).toBe(409);

		const after = await endState(seeded);
		expect(after.job.status).toBe("FAILED");
		expect(after.job.error).toMatch(/signature verification failed/);
		expect(after.env.status).toBe("FAILED");
		expect(after.promotion.status).toBe("FAILED");
		expect(await anotherPromotionIsAccepted(seeded)).toBe(true);
		expect(emitAlertEventSafe).toHaveBeenCalledWith(
			ORG,
			"system.job.failed",
			expect.objectContaining({ job_id: seeded.deployId, job_type: "DEPLOY" }),
		);
	});
});
