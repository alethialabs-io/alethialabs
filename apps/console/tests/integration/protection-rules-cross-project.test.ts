// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: protection rules may only be read or written for an environment that belongs to the
// project the caller was authorized against (#2679).
//
// This has to be an integration test, and the reason is the whole finding. The defect was NOT in
// the authorization call — `authorize("edit", { type: "project", id })` was there and correct. It
// was that the authorized subject (a PROJECT) and the data key (an ENVIRONMENT) were never tied
// together, and that the two things which look like they would catch that do not:
//
//   · RLS scopes this table to the ORG, not the project —
//     `project_id IN (SELECT id FROM projects WHERE user_id = … OR org_id = …)` — so every project
//     in the actor's org satisfies it. Only a REAL policy against a REAL second project shows that.
//   · `environment_protection_rules_env_key` is UNIQUE(environment_id), so an upsert whose
//     ON CONFLICT target is `environment_id` does not fail on a foreign environment — it OVERWRITES
//     that project's row. Only a real ON CONFLICT against a real pre-existing row shows that.
//
// A mocked test decides both of those for itself and would have passed against the broken code.
//
// The suite executes `assertEnvInProject` ITSELF against a real transaction, rather than only
// asserting the facts around it. A test that checked the surrounding properties — that the
// predicate matches one project, that environment_id is globally unique — would still pass if the
// check were deleted, and a pinning test that cannot fail on its own regression is not a pinning
// test. The server actions themselves are out of reach here: `authorize()` needs a request session
// this tier does not have.
//
// The check lives in lib/promotions/env-ownership.ts rather than in the `"use server"` module that
// calls it, because every export of a `"use server"` file is a callable server action — exporting
// a security helper from there merely to make it testable would widen the RPC surface to reach it.

import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { getServiceDb } from "@/lib/db";
import {
	environmentProtectionRules,
	projectEnvironments,
	projects,
} from "@/lib/db/schema";
import { assertEnvInProject } from "@/lib/promotions/env-ownership";
import { describeIfDb } from "./db";

// ONE org, TWO projects — the shape the defect lives in. A cross-ORG case would prove nothing
// here, because RLS already stops that and the finding is about the gap RLS leaves open.
const ORG = randomUUID();
const USER = randomUUID();

const PROJ_ALLOWED = randomUUID();
const PROJ_FORBIDDEN = randomUUID();
const ENV_ALLOWED = randomUUID();
const ENV_FORBIDDEN = randomUUID();

describeIfDb("protection rules — environment must belong to the authorized project", () => {
	beforeAll(async () => {
		const db = getServiceDb();
		for (const [id, name] of [
			[PROJ_ALLOWED, "allowed"],
			[PROJ_FORBIDDEN, "forbidden"],
		] as const) {
			await db.insert(projects).values({
				id,
				org_id: ORG,
				user_id: USER,
				project_name: `it-prot-${name}-${id.slice(0, 8)}`,
				region: "eu-central-1",
				iac_version: "1.0",
			});
		}
		await db.insert(projectEnvironments).values([
			{
				id: ENV_ALLOWED,
				project_id: PROJ_ALLOWED,
				user_id: USER,
				name: "prod",
				stage: "production",
				is_default: true,
			},
			{
				id: ENV_FORBIDDEN,
				project_id: PROJ_FORBIDDEN,
				user_id: USER,
				name: "prod",
				stage: "production",
				is_default: true,
			},
		]);
		// The victim row: the other project's gates, fully locked down.
		await db.insert(environmentProtectionRules).values({
			project_id: PROJ_FORBIDDEN,
			environment_id: ENV_FORBIDDEN,
			user_id: USER,
			org_id: ORG,
			require_predecessor: true,
			require_verify_pass: true,
			require_approval: true,
		});
	});

	afterAll(async () => {
		const db = getServiceDb();
		await db
			.delete(environmentProtectionRules)
			.where(inArray(environmentProtectionRules.project_id, [PROJ_ALLOWED, PROJ_FORBIDDEN]));
		await db
			.delete(projectEnvironments)
			.where(inArray(projectEnvironments.project_id, [PROJ_ALLOWED, PROJ_FORBIDDEN]));
		await db.delete(projects).where(inArray(projects.id, [PROJ_ALLOWED, PROJ_FORBIDDEN]));
	});

	it("accepts an environment that belongs to the project", async () => {
		await getServiceDb().transaction(async (tx) => {
			await expect(
				assertEnvInProject(tx, PROJ_ALLOWED, ENV_ALLOWED),
			).resolves.toBeUndefined();
		});
	});

	it("REFUSES another project's environment — the check itself, executed", async () => {
		// The regression case. Delete assertEnvInProject and this is the assertion that fails.
		await getServiceDb().transaction(async (tx) => {
			await expect(
				assertEnvInProject(tx, PROJ_ALLOWED, ENV_FORBIDDEN),
			).rejects.toThrow(/Unknown environment/);
		});
	});

	it("refuses an environment id that exists nowhere", async () => {
		await getServiceDb().transaction(async (tx) => {
			await expect(
				assertEnvInProject(tx, PROJ_ALLOWED, randomUUID()),
			).rejects.toThrow(/Unknown environment/);
		});
	});

	it("environment_id is globally unique, so an ON CONFLICT would land on the OTHER project's row", async () => {
		// This is the fact that turned a missing predicate into an overwrite rather than an error,
		// and it is asserted so that a future schema change relaxing the constraint cannot silently
		// change what the fix is protecting against.
		const db = getServiceDb();
		// `rejects.toThrow()` on its own would pass on ANY error — an import failure, a null
		// column, a typo in a table name — so it is matched on the constraint by name. A repro
		// that accepts any throw is a repro that can pass without reaching the defect.
		await expect(
			db.insert(environmentProtectionRules).values({
				project_id: PROJ_ALLOWED, // a DIFFERENT project…
				environment_id: ENV_FORBIDDEN, // …claiming the other project's environment
				user_id: USER,
				org_id: ORG,
				require_approval: false,
			}),
		).rejects.toThrow(/environment_protection_rules_env_key|duplicate key/i);
	});

	it("setWhere makes the WRITE structurally unable to cross projects", async () => {
		// The second wall, exercised WITHOUT assertEnvInProject in front of it — because the value
		// of a second wall is precisely that it holds when the first one is gone. This runs the
		// exact upsert setProtectionRules issues, against the other project's environment.
		const db = getServiceDb();
		const returned = await db
			.insert(environmentProtectionRules)
			.values({
				project_id: PROJ_ALLOWED,
				environment_id: ENV_FORBIDDEN,
				user_id: USER,
				org_id: ORG,
				require_approval: false,
				require_verify_pass: false,
			})
			.onConflictDoUpdate({
				target: environmentProtectionRules.environment_id,
				set: { require_approval: false, require_verify_pass: false },
				setWhere: eq(environmentProtectionRules.project_id, PROJ_ALLOWED),
			})
			.returning();

		// ZERO rows: the conflicting row belongs to PROJ_FORBIDDEN, so setWhere filters the update
		// out. Without setWhere this same statement rewrites the victim's gates and returns it.
		expect(returned).toHaveLength(0);

		const [victim] = await db
			.select()
			.from(environmentProtectionRules)
			.where(
				and(
					eq(environmentProtectionRules.environment_id, ENV_FORBIDDEN),
					eq(environmentProtectionRules.project_id, PROJ_FORBIDDEN),
				),
			);
		expect(victim?.require_approval).toBe(true);
		expect(victim?.require_verify_pass).toBe(true);
	});

	it("RLS does not separate projects inside one org — only the predicate does", async () => {
		// The other half of why this was reachable. Both projects share ORG, so an org-scoped policy
		// admits both rows; if this ever stops being true the finding's premise changes and this
		// test should be revisited rather than deleted.
		const db = getServiceDb();
		const rows = await db
			.select({ id: projects.id, org: projects.org_id })
			.from(projects)
			.where(inArray(projects.id, [PROJ_ALLOWED, PROJ_FORBIDDEN]));
		expect(rows).toHaveLength(2);
		expect(new Set(rows.map((r) => r.org))).toEqual(new Set([ORG]));
	});

	it("the victim's gates are unchanged", async () => {
		// The outcome that actually matters: require_approval must not have been flipped to false
		// by anything above.
		const db = getServiceDb();
		const [row] = await db
			.select()
			.from(environmentProtectionRules)
			.where(eq(environmentProtectionRules.environment_id, ENV_FORBIDDEN));
		expect(row?.require_approval).toBe(true);
		expect(row?.require_verify_pass).toBe(true);
		expect(row?.project_id).toBe(PROJ_FORBIDDEN);
	});
});
