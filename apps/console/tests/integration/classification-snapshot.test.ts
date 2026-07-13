// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration (B1.1): proves the real `listAssignmentsFor` reads compose with the pure
// `resolveClassificationSnapshot` fold against Postgres — a project resource and an environment
// resource carry classification assignments, and the resolved snapshot has the environment
// OVERRIDING the project per dimension while inheriting the dimensions the environment doesn't
// touch. Seeds a small taxonomy via the service connection (bypasses RLS); unique ids isolate the
// assertions; cleans up by cascading the dimensions.

import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { getServiceDb } from "@/lib/db";
import {
	classificationAssignment,
	classificationDimension,
	classificationValue,
} from "@/lib/db/schema";
import { inArray } from "drizzle-orm";
import { resolveClassificationSnapshot } from "@/lib/classification/snapshot";
import { listAssignmentsFor } from "@/lib/queries/classification";
import { describeIfDb } from "./db";

const ORG_ID = randomUUID();
const USER_ID = randomUUID();

const DIM_TIER = randomUUID(); // "env-tier" — shared → env overrides project
const DIM_DATA = randomUUID(); // "data-class" — project-only → inherited
const DIM_TEAM = randomUUID(); // "team" — env-only → added

const TIER_DEV = randomUUID();
const TIER_PROD = randomUUID();
const DATA_PII = randomUUID();
const DATA_INTERNAL = randomUUID();
const TEAM_PLATFORM = randomUUID();

// Concrete resources: one project, one of its environments.
const R_PROJECT = randomUUID();
const R_ENV = randomUUID();

// Slug the keys/values with a unique suffix so parallel orgs never collide on the unique indexes.
const sfx = ORG_ID.slice(0, 6);

describeIfDb("classification snapshot (project ⇄ environment resolution)", () => {
	it("resolves env-overrides-project into the frozen per-dimension snapshot", async () => {
		const db = getServiceDb();
		await db.insert(classificationDimension).values([
			{ id: DIM_TIER, org_id: ORG_ID, created_by: USER_ID, key: `tier-${sfx}`, label: "Tier", multi: false },
			{ id: DIM_DATA, org_id: ORG_ID, created_by: USER_ID, key: `data-${sfx}`, label: "Data", multi: true },
			{ id: DIM_TEAM, org_id: ORG_ID, created_by: USER_ID, key: `team-${sfx}`, label: "Team", multi: true },
		]);
		await db.insert(classificationValue).values([
			{ id: TIER_DEV, org_id: ORG_ID, dimension_id: DIM_TIER, value: "dev", label: "Dev" },
			{ id: TIER_PROD, org_id: ORG_ID, dimension_id: DIM_TIER, value: "prod", label: "Prod" },
			{ id: DATA_PII, org_id: ORG_ID, dimension_id: DIM_DATA, value: "pii", label: "PII" },
			{ id: DATA_INTERNAL, org_id: ORG_ID, dimension_id: DIM_DATA, value: "internal", label: "Internal" },
			{ id: TEAM_PLATFORM, org_id: ORG_ID, dimension_id: DIM_TEAM, value: "platform", label: "Platform" },
		]);
		await db.insert(classificationAssignment).values([
			// Project: tier=dev, data-class={pii, internal}.
			{ org_id: ORG_ID, dimension_id: DIM_TIER, value_id: TIER_DEV, resource_kind: "project", resource_id: R_PROJECT, assigned_by: USER_ID },
			{ org_id: ORG_ID, dimension_id: DIM_DATA, value_id: DATA_PII, resource_kind: "project", resource_id: R_PROJECT, assigned_by: USER_ID },
			{ org_id: ORG_ID, dimension_id: DIM_DATA, value_id: DATA_INTERNAL, resource_kind: "project", resource_id: R_PROJECT, assigned_by: USER_ID },
			// Environment: tier=prod (overrides project's dev), team=platform (env-only).
			{ org_id: ORG_ID, dimension_id: DIM_TIER, value_id: TIER_PROD, resource_kind: "project_environment", resource_id: R_ENV, assigned_by: USER_ID },
			{ org_id: ORG_ID, dimension_id: DIM_TEAM, value_id: TEAM_PLATFORM, resource_kind: "project_environment", resource_id: R_ENV, assigned_by: USER_ID },
		]);

		try {
			const [projectChips, envChips] = await db.transaction(async (tx) => [
				await listAssignmentsFor(tx, "project", R_PROJECT),
				await listAssignmentsFor(tx, "project_environment", R_ENV),
			]);
			const snapshot = resolveClassificationSnapshot(projectChips, envChips);

			expect(snapshot).toEqual({
				[`data-${sfx}`]: ["internal", "pii"], // project-only → inherited, sorted
				[`tier-${sfx}`]: ["prod"], // shared → env overrides project's "dev"
				[`team-${sfx}`]: ["platform"], // env-only → added
			});
			expect(Object.isFrozen(snapshot)).toBe(true);
		} finally {
			await db
				.delete(classificationDimension)
				.where(inArray(classificationDimension.id, [DIM_TIER, DIM_DATA, DIM_TEAM]));
		}
	});
});
