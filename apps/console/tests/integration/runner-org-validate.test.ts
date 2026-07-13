// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: the defense-in-depth enqueue guard `assertRunnerInOrg` against real
// Postgres. Seeds two orgs, each with a self-operated runner, and proves the guard
// ACCEPTS an in-org runner and REJECTS a cross-org runner, a non-existent runner id
// (same rejection — no cross-tenant disclosure), and a managed (org_id NULL) runner.
//
// The runner's owning org is read from `runners.org_id` — the SAME column
// claim_next_job compares against `v_runner_org_id` — so this exercises the exact
// notion of "the runner's org" the execution guard uses. `org_id` is backfilled to
// `user_id` by the set_org_id trigger on insert, which this test also asserts.

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { assertRunnerInOrg } from "@/lib/authz/runner-org";
import { ForbiddenError } from "@/lib/authz/types";
import { getServiceDb } from "@/lib/db";
import { runners } from "@/lib/db/schema";
import { describeIfDb, seedManagedRunner } from "./db";

// Community model: org_id === user_id (backfilled by the set_org_id trigger).
const ORG_A = randomUUID();
const ORG_B = randomUUID();

let runnerA: string;
let runnerB: string;
let managedRunner: string;

/** Inserts a self-operated runner owned by `userId`; org_id backfills to user_id. */
async function seedSelfRunner(userId: string, name: string): Promise<string> {
	const [row] = await getServiceDb()
		.insert(runners)
		.values({
			user_id: userId,
			name,
			operator: "self", // self ⇒ user_id NOT NULL + provisioning NOT NULL (CHECKs)
			provisioning: "registered",
			token_hash: `hash-${name}`,
			status: "OFFLINE",
		})
		.returning({ id: runners.id, org_id: runners.org_id });
	// The set_org_id trigger must backfill org_id = user_id — the org notion the
	// claim guard (v_runner_org_id) and this validator both key on.
	expect(row.org_id).toBe(userId);
	return row.id;
}

describeIfDb("assertRunnerInOrg (defense-in-depth enqueue guard)", () => {
	beforeAll(async () => {
		runnerA = await seedSelfRunner(ORG_A, `it-runner-a-${ORG_A.slice(0, 8)}`);
		runnerB = await seedSelfRunner(ORG_B, `it-runner-b-${ORG_B.slice(0, 8)}`);
		managedRunner = await seedManagedRunner(`it-managed-${ORG_A.slice(0, 8)}`);
	});

	afterAll(async () => {
		const db = getServiceDb();
		await db.delete(runners).where(eq(runners.id, runnerA));
		await db.delete(runners).where(eq(runners.id, runnerB));
		await db.delete(runners).where(eq(runners.id, managedRunner));
	});

	it("ACCEPTS a runner that belongs to the caller's org", async () => {
		await expect(
			assertRunnerInOrg(getServiceDb(), runnerA, ORG_A),
		).resolves.toBeUndefined();
		await expect(
			assertRunnerInOrg(getServiceDb(), runnerB, ORG_B),
		).resolves.toBeUndefined();
	});

	it("REJECTS a runner owned by another org (cross-tenant assignment)", async () => {
		await expect(
			assertRunnerInOrg(getServiceDb(), runnerB, ORG_A),
		).rejects.toBeInstanceOf(ForbiddenError);
		await expect(
			assertRunnerInOrg(getServiceDb(), runnerA, ORG_B),
		).rejects.toBeInstanceOf(ForbiddenError);
	});

	it("REJECTS a non-existent runner id with the SAME error (no disclosure)", async () => {
		await expect(
			assertRunnerInOrg(getServiceDb(), randomUUID(), ORG_A),
		).rejects.toBeInstanceOf(ForbiddenError);
	});

	it("REJECTS a managed (org_id NULL) runner for any tenant — fail closed", async () => {
		await expect(
			assertRunnerInOrg(getServiceDb(), managedRunner, ORG_A),
		).rejects.toBeInstanceOf(ForbiddenError);
	});
});
