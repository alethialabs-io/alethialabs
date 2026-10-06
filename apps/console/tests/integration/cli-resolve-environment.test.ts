// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: resolveCliEnvironment (used by every env-scoped CLI route). It matches an
// environment within a project by id, name, OR stage, ranked id > exact name > stage, and among
// stage matches prefers the is_default row, then the oldest (#5583). A mock can't catch the pgEnum stage comparison — it's real SQL against
// the environmentStage enum column, guarded by isEnvironmentStage so an arbitrary --env string
// never reaches the enum comparison as an invalid literal.

import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { resolveCliEnvironment } from "@/lib/cli/resolve-project";
import { getServiceDb } from "@/lib/db";
import { projectEnvironments, projects } from "@/lib/db/schema";
import { describeIfDb } from "./db";

const ORG = randomUUID();
const USER = randomUUID();
const PROJ = randomUUID();
const ENV_PROD = randomUUID();
const ENV_STAGING = randomUUID();

describeIfDb("resolveCliEnvironment — id/name/stage matching", () => {
	beforeAll(async () => {
		const db = getServiceDb();
		await db.insert(projects).values({
			id: PROJ,
			org_id: ORG,
			user_id: USER,
			project_name: `p-${PROJ}`,
			region: "westeurope",
			iac_version: "1.0",
		});
		// One transaction: the first insert alone leaves this project with an environment and no
		// default, which `project_environments_one_default_check` (lib/db/programmables.sql) refuses.
		// The trigger is DEFERRED, so it judges the state at COMMIT — the pair is what has to be
		// valid, not each statement.
		await db.transaction(async (tx) => {
			await tx.insert(projectEnvironments).values({
				id: ENV_STAGING,
				project_id: PROJ,
				user_id: USER,
				name: "staging",
				stage: "staging",
				is_default: false,
			});
			await tx.insert(projectEnvironments).values({
				id: ENV_PROD,
				project_id: PROJ,
				user_id: USER,
				name: "production",
				stage: "production",
				is_default: true,
			});
		});
	});

	afterAll(async () => {
		const db = getServiceDb();
		await db.delete(projectEnvironments).where(eq(projectEnvironments.project_id, PROJ));
		await db.delete(projects).where(eq(projects.id, PROJ));
	});

	it("resolves by environment name", async () => {
		const env = await resolveCliEnvironment(PROJ, "staging");
		expect(env?.id).toBe(ENV_STAGING);
	});

	it("resolves by stage", async () => {
		const env = await resolveCliEnvironment(PROJ, "production");
		expect(env?.id).toBe(ENV_PROD);
	});

	it("resolves by environment id", async () => {
		const env = await resolveCliEnvironment(PROJ, ENV_STAGING);
		expect(env?.id).toBe(ENV_STAGING);
	});

	it("returns null for an unknown environment (and never errors on a non-stage string)", async () => {
		expect(await resolveCliEnvironment(PROJ, "does-not-exist")).toBeNull();
	});
});

// #5583: the project where the old ranking went wrong. The DEFAULT environment `main` sits at stage
// `staging`, and a second environment is literally NAMED `staging`. Ranking every match by
// is_default alone resolved `staging` to `main`, so `alethia plan`/`apply` for `staging` read and
// wrote the default environment's components. Two more environments pin that a value matching ONLY
// by stage resolves as before: the default first, then the oldest.
const PROJ_NAMED = randomUUID();
const ENV_MAIN = randomUUID();
const ENV_NAMED_STAGING = randomUUID();
const ENV_PREVIEW_OLD = randomUUID();
const ENV_PREVIEW_NEW = randomUUID();
const PROJ_STAGE = randomUUID();
const ENV_LIVE = randomUUID();
const ENV_EU_OLDER = randomUUID();
// Another organization's project, holding an environment whose name AND stage are `staging`.
const ORG_FOREIGN = randomUUID();
const PROJ_FOREIGN = randomUUID();
const ENV_FOREIGN = randomUUID();

describeIfDb("resolveCliEnvironment — an exact name beats a stage (#5583)", () => {
	beforeAll(async () => {
		const db = getServiceDb();
		for (const [id, org] of [
			[PROJ_NAMED, ORG],
			[PROJ_STAGE, ORG],
			[PROJ_FOREIGN, ORG_FOREIGN],
		]) {
			await db.insert(projects).values({
				id,
				org_id: org,
				user_id: USER,
				project_name: `p-${id}`,
				region: "westeurope",
				iac_version: "1.0",
			});
		}
		// One transaction per project, for the deferred one-default check (see above).
		await db.transaction(async (tx) => {
			await tx.insert(projectEnvironments).values([
				{ id: ENV_MAIN, project_id: PROJ_NAMED, user_id: USER, name: "main", stage: "staging", is_default: true },
				{ id: ENV_NAMED_STAGING, project_id: PROJ_NAMED, user_id: USER, name: "staging", stage: "development", is_default: false },
				// Two non-default environments at one stage, neither named for it: the older one wins.
				{ id: ENV_PREVIEW_NEW, project_id: PROJ_NAMED, user_id: USER, name: "preview-b", stage: "production", is_default: false, created_at: new Date("2026-02-01T00:00:00Z") },
				{ id: ENV_PREVIEW_OLD, project_id: PROJ_NAMED, user_id: USER, name: "preview-a", stage: "production", is_default: false, created_at: new Date("2026-01-01T00:00:00Z") },
			]);
		});
		await db.transaction(async (tx) => {
			await tx.insert(projectEnvironments).values([
				// The default is the NEWER of two production environments: is_default outranks age.
				{ id: ENV_EU_OLDER, project_id: PROJ_STAGE, user_id: USER, name: "eu", stage: "production", is_default: false, created_at: new Date("2026-01-01T00:00:00Z") },
				{ id: ENV_LIVE, project_id: PROJ_STAGE, user_id: USER, name: "live", stage: "production", is_default: true, created_at: new Date("2026-03-01T00:00:00Z") },
			]);
		});
		await db.insert(projectEnvironments).values({
			id: ENV_FOREIGN,
			project_id: PROJ_FOREIGN,
			user_id: USER,
			name: "staging",
			stage: "staging",
			is_default: true,
		});
	});

	afterAll(async () => {
		const db = getServiceDb();
		await db
			.delete(projectEnvironments)
			.where(inArray(projectEnvironments.project_id, [PROJ_NAMED, PROJ_STAGE, PROJ_FOREIGN]));
		await db
			.delete(projects)
			.where(inArray(projects.id, [PROJ_NAMED, PROJ_STAGE, PROJ_FOREIGN]));
	});

	it("resolves `staging` to the environment NAMED staging, not the default at stage staging", async () => {
		const env = await resolveCliEnvironment(PROJ_NAMED, "staging");
		expect(env?.id).toBe(ENV_NAMED_STAGING);
	});

	it("still resolves the default by its own name and id", async () => {
		expect((await resolveCliEnvironment(PROJ_NAMED, "main"))?.id).toBe(ENV_MAIN);
		expect((await resolveCliEnvironment(PROJ_NAMED, ENV_MAIN))?.id).toBe(ENV_MAIN);
	});

	it("a stage that names no environment still resolves by stage — the default first", async () => {
		const env = await resolveCliEnvironment(PROJ_STAGE, "production");
		expect(env?.id).toBe(ENV_LIVE);
	});

	it("an environment id from another project, or another organization, matches nothing", async () => {
		// Real ids, in other projects: the id matcher is scoped by project_id like the name and stage
		// matchers, so it must not cross over — within one organization or across two.
		expect(await resolveCliEnvironment(PROJ_NAMED, ENV_LIVE)).toBeNull();
		expect(await resolveCliEnvironment(PROJ_NAMED, ENV_FOREIGN)).toBeNull();
		expect(await resolveCliEnvironment(PROJ_STAGE, ENV_MAIN)).toBeNull();
		// The foreign project's `staging` (name AND stage, and its default) does not compete either.
		expect((await resolveCliEnvironment(PROJ_NAMED, "staging"))?.id).toBe(ENV_NAMED_STAGING);
	});

	it("a stage matched only by non-default environments resolves to the oldest", async () => {
		const env = await resolveCliEnvironment(PROJ_NAMED, "production");
		expect(env?.id).toBe(ENV_PREVIEW_OLD);
	});
});
