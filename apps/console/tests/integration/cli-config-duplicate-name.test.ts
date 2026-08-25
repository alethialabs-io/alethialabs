// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: getCliConfig resolves DETERMINISTICALLY when two projects share a name (#2663).
//
// This suite exists for two reasons, and the second is the reason it is an integration test and
// not a mocked unit test.
//
// 1. `project_name` has no uniqueness constraint — the only unique on `projects` is
//    (org_id, slug) — and duplicates are the DESIGNED behaviour of the create path, which
//    de-duplicates the SLUG and inserts the name verbatim. `getCliConfig` took `.limit(1)` with no
//    ORDER BY, so which project the CLI resolved was undefined.
//
// 2. `lib/queries/**` is excluded from the unit coverage scope under the claim that each file is
//    "verified by the integration tier". For `lib/queries/cli-config.ts` that claim was FALSE — no
//    integration test named it, and no unit test either. It was covered by nothing, which is how a
//    resolver behind three authenticated CLI routes kept an undefined result. This file is the
//    evidence the exclusion was asserting.
//
// A mocked test could not catch either half: the ordering is real SQL, and the point at issue is
// what Postgres returns for an unordered LIMIT 1 — which a mock decides for itself.

import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { getServiceDb } from "@/lib/db";
import { projectEnvironments, projects } from "@/lib/db/schema";
import { getCliConfig } from "@/lib/queries/cli-config";
import { describeIfDb } from "./db";

const ORG = randomUUID();
const USER = randomUUID();

// The rows are inserted in the OPPOSITE order to the one they must resolve in, so a result that
// merely reflected physical insertion order would fail. (The ids are random UUIDs, so their sort
// order relative to the timestamps is not controlled — insertion order is the control here, and
// `created_at` is what the ORDER BY actually keys on.)
const OLDER = randomUUID();
const NEWER = randomUUID();
const ENV_OLDER = randomUUID();
const ENV_NEWER = randomUUID();

const SHARED_NAME = `dup-${randomUUID().slice(0, 8)}`;

const OLDER_CREATED = new Date("2026-01-01T00:00:00.000Z");
const NEWER_CREATED = new Date("2026-06-01T00:00:00.000Z");

describeIfDb("getCliConfig — two projects, one name", () => {
	beforeAll(async () => {
		const db = getServiceDb();
		// NEWER first, so insertion order is the OPPOSITE of the expected resolution order.
		await db.insert(projects).values({
			id: NEWER,
			org_id: ORG,
			user_id: USER,
			project_name: SHARED_NAME,
			region: "westeurope",
			iac_version: "1.0",
			slug: `${SHARED_NAME}-2`,
			created_at: NEWER_CREATED,
		});
		await db.insert(projects).values({
			id: OLDER,
			org_id: ORG,
			user_id: USER,
			project_name: SHARED_NAME,
			region: "eu-central-1",
			iac_version: "1.0",
			slug: SHARED_NAME,
			created_at: OLDER_CREATED,
		});
		await db.insert(projectEnvironments).values({
			id: ENV_NEWER,
			project_id: NEWER,
			user_id: USER,
			name: "newer-default",
			stage: "production",
			is_default: true,
		});
		await db.insert(projectEnvironments).values({
			id: ENV_OLDER,
			project_id: OLDER,
			user_id: USER,
			name: "older-default",
			stage: "production",
			is_default: true,
		});
	});

	afterAll(async () => {
		const db = getServiceDb();
		await db
			.delete(projectEnvironments)
			.where(inArray(projectEnvironments.project_id, [OLDER, NEWER]));
		await db.delete(projects).where(inArray(projects.id, [OLDER, NEWER]));
	});

	it("resolves the OLDEST project, not an arbitrary one", async () => {
		const cfg = await getCliConfig(getServiceDb(), {
			userId: USER,
			projectName: SHARED_NAME,
		});
		expect(cfg).not.toBeNull();
		expect(cfg?.id).toBe(OLDER);
		// The region is what a user would actually notice resolving to the wrong project: it is the
		// field the CLI hands onward.
		expect(cfg?.region).toBe("eu-central-1");
	});

	it("resolves the same project on every call", async () => {
		// The defect was an UNDEFINED result, not a wrong-but-stable one, so a single assertion
		// could pass by luck. Repeating it makes an unordered LIMIT 1 far likelier to be caught,
		// and makes the intent — stability — explicit to a reader.
		const ids = new Set<string>();
		for (let i = 0; i < 5; i += 1) {
			const cfg = await getCliConfig(getServiceDb(), {
				userId: USER,
				projectName: SHARED_NAME,
			});
			if (cfg) ids.add(cfg.id);
		}
		expect([...ids]).toEqual([OLDER]);
	});

	it("still honours an explicit envId, and refuses one from another project", async () => {
		const mine = await getCliConfig(getServiceDb(), {
			userId: USER,
			projectName: SHARED_NAME,
			envId: ENV_OLDER,
		});
		expect(mine?.environment_stage).toBe("older-default");

		// ENV_NEWER belongs to the OTHER project. `envs` is already scoped to the resolved
		// project, so this must miss rather than cross the boundary — asserted so a future
		// refactor that "helpfully" widens the environment lookup is caught here.
		const crossed = await getCliConfig(getServiceDb(), {
			userId: USER,
			projectName: SHARED_NAME,
			envId: ENV_NEWER,
		});
		expect(crossed).toBeNull();
	});

	it("returns null for another user's project of the same name", async () => {
		const other = await getCliConfig(getServiceDb(), {
			userId: randomUUID(),
			projectName: SHARED_NAME,
		});
		expect(other).toBeNull();
	});

	it("falls back deterministically when no environment is flagged default", async () => {
		const db = getServiceDb();
		// The `envs[0]` fallback path: clear is_default on the resolved project's only env and add
		// a second, older one. Without an ORDER BY this pick was arbitrary too.
		const EXTRA = randomUUID();
		await db.insert(projectEnvironments).values({
			id: EXTRA,
			project_id: OLDER,
			user_id: USER,
			name: "oldest-non-default",
			stage: "staging",
			is_default: false,
			created_at: new Date("2025-01-01T00:00:00.000Z"),
		});
		await db
			.update(projectEnvironments)
			.set({ is_default: false })
			.where(eq(projectEnvironments.id, ENV_OLDER));
		try {
			const seen = new Set<string>();
			for (let i = 0; i < 5; i += 1) {
				const cfg = await getCliConfig(getServiceDb(), {
					userId: USER,
					projectName: SHARED_NAME,
				});
				if (cfg) seen.add(cfg.environment_stage);
			}
			expect([...seen]).toEqual(["oldest-non-default"]);
		} finally {
			await db
				.update(projectEnvironments)
				.set({ is_default: true })
				.where(eq(projectEnvironments.id, ENV_OLDER));
			await db.delete(projectEnvironments).where(eq(projectEnvironments.id, EXTRA));
		}
	});
});
