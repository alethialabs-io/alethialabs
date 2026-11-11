// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration (#6541): the environment's BYO admission setting, against real Postgres.
//
//   * every change of the setting writes an audit row naming who, which environment and old → new,
//     in BOTH directions, in the same transaction as the write; a save that changes nothing writes
//     none;
//   * an environment of another project is refused, and nothing is written;
//   * the Environments card reads "redeploy to apply" from what the latest deploy CARRIED: a deploy
//     built before the change keeps the old value, so the note stays until a new one is made.

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { beforeAll, expect, it } from "vitest";
import { getServiceDb } from "@/lib/db";
import { auditLog, jobs, projectAddons, projectEnvironments, projects } from "@/lib/db/schema";
import { readByoAdmissionCardStates } from "@/lib/environments/byo-admission-state";
import { writeByoAdmissionEnforce } from "@/lib/environments/byo-admission-write";
import { defaultIfFirst, describeIfDb } from "./db";

const USER = randomUUID();
const ORG = randomUUID();
const db = getServiceDb();

describeIfDb("BYO admission setting — real Postgres", () => {
	let projectId = "";
	let otherProjectId = "";
	let envId = "";
	let plainEnvId = "";

	/** A project of USER's org named `name`. */
	async function seedProject(name: string): Promise<string> {
		const [p] = await db
			.insert(projects)
			.values({ user_id: USER, org_id: ORG, project_name: name, region: "us-east-1", iac_version: "1.9.5" })
			.returning({ id: projects.id });
		return p.id;
	}

	/** An environment of `project` named `name`. */
	async function seedEnv(project: string, name: string): Promise<string> {
		const [e] = await db
			.insert(projectEnvironments)
			.values({ project_id: project, user_id: USER, org_id: ORG, name, stage: "development", is_default: defaultIfFirst(project) })
			.returning({ id: projectEnvironments.id });
		return e.id;
	}

	/** A DEPLOY job of `env` whose frozen snapshot carries `snapshot`. */
	async function seedDeploy(env: string, snapshot: Record<string, unknown>, createdAt: Date): Promise<void> {
		await db.insert(jobs).values({
			user_id: USER,
			org_id: ORG,
			project_id: projectId,
			environment_id: env,
			job_type: "DEPLOY",
			status: "SUCCESS",
			config_snapshot: snapshot,
			created_at: createdAt,
		});
	}

	/** The audit rows of the project, oldest first. */
	async function audits() {
		return db
			.select({ user_id: auditLog.user_id, action: auditLog.action, changes: auditLog.changes })
			.from(auditLog)
			.where(eq(auditLog.project_id, projectId))
			.orderBy(auditLog.id);
	}

	beforeAll(async () => {
		projectId = await seedProject("byo-admission-setting");
		otherProjectId = await seedProject("byo-admission-other");
		envId = await seedEnv(projectId, "dev");
		plainEnvId = await seedEnv(projectId, "plain");
		await db.insert(projectAddons).values({ project_id: projectId, environment_id: envId, addon_id: "shop", source: "byo" });
	});

	it("audits each change in both directions, and nothing for a save that changes nothing", async () => {
		const input = (enforce: boolean) => ({ projectId, environmentId: envId, enforce });
		expect(await db.transaction((tx) => writeByoAdmissionEnforce(tx, USER, input(true)))).toEqual({ changed: true });
		expect(await db.transaction((tx) => writeByoAdmissionEnforce(tx, USER, input(true)))).toEqual({ changed: false });
		expect(await db.transaction((tx) => writeByoAdmissionEnforce(tx, USER, input(false)))).toEqual({ changed: true });

		expect(await audits()).toEqual([
			{ user_id: USER, action: "UPDATED", changes: { environment_id: envId, byo_admission_enforce: { from: false, to: true } } },
			{ user_id: USER, action: "UPDATED", changes: { environment_id: envId, byo_admission_enforce: { from: true, to: false } } },
		]);
		const [row] = await db
			.select({ enforce: projectEnvironments.byo_admission_enforce })
			.from(projectEnvironments)
			.where(eq(projectEnvironments.id, envId));
		expect(row.enforce).toBe(false);
	});

	it("refuses an environment of another project and writes nothing", async () => {
		const before = (await audits()).length;
		await expect(
			db.transaction((tx) => writeByoAdmissionEnforce(tx, USER, { projectId: otherProjectId, environmentId: envId, enforce: true })),
		).rejects.toThrow("Environment not found");
		expect((await audits()).length).toBe(before);
		const [row] = await db
			.select({ enforce: projectEnvironments.byo_admission_enforce })
			.from(projectEnvironments)
			.where(and(eq(projectEnvironments.id, envId), eq(projectEnvironments.project_id, projectId)));
		expect(row.enforce).toBe(false);
	});

	it("says 'redeploy to apply' until a deploy carries the setting, and only where a BYO chart is", async () => {
		await seedDeploy(envId, { byo_admission: { enforce: false, deployed_charts: [] } }, new Date("2026-11-01T00:00:00Z"));
		const states = (enforce: boolean) =>
			readByoAdmissionCardStates(projectId, new Map([[envId, enforce], [plainEnvId, enforce]]));

		expect((await states(false)).get(envId)).toEqual({ hasByoCharts: true, pending: false });
		expect((await states(true)).get(envId)).toEqual({ hasByoCharts: true, pending: true });
		expect((await states(true)).get(plainEnvId)).toEqual({ hasByoCharts: false, pending: false });

		await seedDeploy(envId, { byo_admission: { enforce: true, deployed_charts: [] } }, new Date("2026-11-02T00:00:00Z"));
		expect((await states(true)).get(envId)).toEqual({ hasByoCharts: true, pending: false });
	});
});
