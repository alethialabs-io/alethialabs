// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: sweep_offline_runners() against real Postgres, for audit finding #21 — a
// managed runner left DRAINING by the fleet controller whose VM then dies HARD (no clean SSE
// abort, so runner_lost never fires) must still be reaped so its open runner_usage_sessions
// row is closed and it stops billing forever.
//
// The fix extends the sweep's `stale` predicate from `status = 'ONLINE'` to
// `status IN ('ONLINE','DRAINING')`, still gated by the 45s stale-heartbeat window. This suite
// proves the three cases that matter:
//   (1) DRAINING + stale heartbeat  → swept OFFLINE, session closed (billing frozen);
//   (2) DRAINING + FRESH heartbeat  → NOT swept (a live drainer keeps heartbeating via
//       runner_present, which preserves DRAINING) — proves a live drainer is never falsely reaped;
//   (3) ONLINE + stale heartbeat    → still swept (regression guard on the pre-existing path).
// Seeds via getServiceDb() (bypasses RLS) with unique ids; asserts only on seeded ids so
// concurrent rows can't perturb it; cleans up after itself.

import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { getServiceDb } from "@/lib/db";
import { runnerUsageSessions, runners } from "@/lib/db/schema";
import type { RunnerStatus } from "@/lib/db/schema/enums";
import { describeIfDb } from "./db";

/**
 * Insert a managed runner with an explicit status + last_heartbeat (minutes ago), plus an OPEN
 * runner_usage_sessions row (ended_at NULL), and return the runner id. Mirrors the state the
 * fleet controller + open_runner_session leave a live managed runner in.
 */
async function seedManagedRunnerWithOpenSession(
	name: string,
	status: RunnerStatus,
	heartbeatAgoMinutes: number,
): Promise<string> {
	const db = getServiceDb();
	const [runner] = await db
		.insert(runners)
		.values({
			name,
			operator: "managed", // managed ⇒ user_id NULL (CHECK) ⇒ billed by provisioned hours
			token_hash: `hash-${name}`,
			status,
			last_heartbeat: sql`now() - make_interval(mins => ${heartbeatAgoMinutes})`,
		})
		.returning({ id: runners.id });
	await db.insert(runnerUsageSessions).values({
		runner_id: runner.id,
		operator: "managed",
		org_id: null,
		// Session opened before the last heartbeat so the close attributes a positive duration.
		started_at: sql`now() - make_interval(mins => ${heartbeatAgoMinutes + 5})`,
	});
	return runner.id;
}

/** The current status of a seeded runner. */
async function runnerStatusOf(id: string): Promise<string | undefined> {
	const [row] = await getServiceDb()
		.select({ status: runners.status })
		.from(runners)
		.where(eq(runners.id, id));
	return row?.status ?? undefined;
}

/** True when the runner still has an OPEN usage session (ended_at IS NULL) — i.e. still billing. */
async function hasOpenSession(id: string): Promise<boolean> {
	const [row] = await getServiceDb()
		.select({ id: runnerUsageSessions.id })
		.from(runnerUsageSessions)
		.where(
			and(
				eq(runnerUsageSessions.runner_id, id),
				isNull(runnerUsageSessions.ended_at),
			),
		);
	return Boolean(row);
}

describeIfDb("sweep_offline_runners — stale DRAINING runner (audit #21)", () => {
	let deadDrainer: string; // DRAINING, heartbeat 2 min ago (VM died hard) → must be swept
	let liveDrainer: string; // DRAINING, heartbeat now (still alive) → must NOT be swept
	let deadOnline: string; // ONLINE, heartbeat 2 min ago → swept (regression guard)

	beforeAll(async () => {
		deadDrainer = await seedManagedRunnerWithOpenSession(
			`it-drain-dead-${randomUUID().slice(0, 8)}`,
			"DRAINING",
			2,
		);
		liveDrainer = await seedManagedRunnerWithOpenSession(
			`it-drain-live-${randomUUID().slice(0, 8)}`,
			"DRAINING",
			0, // heartbeat now — a live drainer still heartbeating via runner_present
		);
		deadOnline = await seedManagedRunnerWithOpenSession(
			`it-online-dead-${randomUUID().slice(0, 8)}`,
			"ONLINE",
			2,
		);
		// Run the sweep once for the whole suite; each test asserts on its own runner.
		await getServiceDb().execute(sql`select * from sweep_offline_runners()`);
	});

	afterAll(async () => {
		const ids = [deadDrainer, liveDrainer, deadOnline];
		const db = getServiceDb();
		await db
			.delete(runnerUsageSessions)
			.where(inArray(runnerUsageSessions.runner_id, ids));
		await db.delete(runners).where(inArray(runners.id, ids));
	});

	it("sweeps a stale-heartbeat DRAINING runner OFFLINE and closes its session (billing frozen)", async () => {
		expect(await runnerStatusOf(deadDrainer)).toBe("OFFLINE");
		expect(await hasOpenSession(deadDrainer)).toBe(false);
	});

	it("does NOT sweep a live DRAINING runner with a fresh heartbeat (session stays open)", async () => {
		expect(await runnerStatusOf(liveDrainer)).toBe("DRAINING");
		expect(await hasOpenSession(liveDrainer)).toBe(true);
	});

	it("still sweeps a stale ONLINE runner as before (regression guard)", async () => {
		expect(await runnerStatusOf(deadOnline)).toBe("OFFLINE");
		expect(await hasOpenSession(deadOnline)).toBe(false);
	});
});
