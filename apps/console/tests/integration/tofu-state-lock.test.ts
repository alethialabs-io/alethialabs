// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: the tofu-state advisory lock RPCs against real Postgres — focused on the
// force-release cleanup tool that ships with mid-flight cancel. Proves force_release_tofu_state_lock
// FENCES the old holder (rotates lock_id + bumps the monotonic generation, never a naive delete)
// and expires the row so a fresh apply can immediately re-acquire. Seeds via getServiceDb()
// (bypasses RLS) with a unique state_key and cleans up after itself.

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { getServiceDb } from "@/lib/db";
import { jobs, tofuStateLocks } from "@/lib/db/schema";
import {
	acquireStateLock,
	forceReleaseStateLock,
	validateStateLock,
} from "@/lib/runners/state-lock";
import { describeIfDb } from "./db";

const STATE_KEY = `it-force-release-${randomUUID()}`;
const ORG = randomUUID();
// A real job the lock's job_id FK can point at (acquire_tofu_state_lock stamps it).
let JOB_ID: string;

async function generationOf(): Promise<number | null> {
	const [row] = await getServiceDb()
		.select({ generation: tofuStateLocks.generation })
		.from(tofuStateLocks)
		.where(eq(tofuStateLocks.state_key, STATE_KEY))
		.limit(1);
	return row?.generation ?? null;
}

describeIfDb("force_release_tofu_state_lock", () => {
	beforeAll(async () => {
		const [row] = await getServiceDb()
			.insert(jobs)
			.values({
				user_id: ORG,
				org_id: ORG,
				job_type: "DEPLOY",
				status: "PROCESSING",
				config_snapshot: {},
			})
			.returning({ id: jobs.id });
		JOB_ID = row.id;
	});

	afterAll(async () => {
		await getServiceDb()
			.delete(tofuStateLocks)
			.where(eq(tofuStateLocks.state_key, STATE_KEY));
		await getServiceDb().delete(jobs).where(eq(jobs.id, JOB_ID));
	});

	it("fences the old holder (rotates lock_id + bumps generation) and lets a fresh apply re-acquire", async () => {
		// A runner acquires the lock for an apply.
		const lockA = randomUUID();
		const first = await acquireStateLock(STATE_KEY, lockA, JOB_ID, {
			ID: lockA,
			Who: "runner-a",
		});
		expect(first.acquired).toBe(true);
		expect(await validateStateLock(STATE_KEY, lockA)).toBe(true);
		const genBefore = await generationOf();
		expect(genBefore).not.toBeNull();

		// The apply is cancelled and the runner is SIGKILLed before UNLOCK → force-release it.
		const released = await forceReleaseStateLock(STATE_KEY);
		expect(released).toBe(true);

		// The old holder is fenced out: its lock_id no longer validates (a zombie write is rejected).
		expect(await validateStateLock(STATE_KEY, lockA)).toBe(false);
		// The monotonic generation was bumped (the steal invariant), not reset by a delete.
		expect(await generationOf()).toBe((genBefore as number) + 1);

		// A fresh apply can immediately re-acquire (the row was expired), bumping generation again.
		const lockB = randomUUID();
		const second = await acquireStateLock(STATE_KEY, lockB, JOB_ID, {
			ID: lockB,
			Who: "runner-b",
		});
		expect(second.acquired).toBe(true);
		expect(await validateStateLock(STATE_KEY, lockB)).toBe(true);
		expect(await generationOf()).toBe((genBefore as number) + 2);
	});

	it("returns false when there is no lock for the key", async () => {
		expect(await forceReleaseStateLock(`it-absent-${randomUUID()}`)).toBe(false);
	});
});
