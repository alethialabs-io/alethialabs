// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { sql } from "drizzle-orm";
import { getServiceDb } from "@/lib/db";

/**
 * Lock TTL for a tofu-state object. Deliberately > the 2h job timeout so a LIVE apply is never
 * stolen mid-run (tofu does not renew the lock during an apply). Expiry is only a safety valve for
 * a crashed runner; a steal changes `lock_id`, so a slow writer's stale `?ID=` then fails the fence.
 */
const LOCK_TTL_SECONDS = 3 * 60 * 60;

/** Acquires the state lock, stealing only an expired one. Returns the current holder's info on conflict. */
export async function acquireStateLock(
	stateKey: string,
	lockId: string,
	jobId: string,
	info: unknown,
): Promise<{ acquired: boolean; holder: Record<string, unknown> | null }> {
	const db = getServiceDb();
	const rows = await db.execute<{
		acquired: boolean;
		holder: Record<string, unknown> | null;
	}>(
		sql`select acquired, holder from acquire_tofu_state_lock(${stateKey}, ${lockId}, ${jobId}::uuid, ${JSON.stringify(info)}::jsonb, ${LOCK_TTL_SECONDS})`,
	);
	const row = rows[0];
	return { acquired: !!row?.acquired, holder: row?.holder ?? null };
}

/** Releases the lock iff `lockId` matches the held one. Returns whether a lock was released. */
export async function releaseStateLock(
	stateKey: string,
	lockId: string,
): Promise<boolean> {
	const db = getServiceDb();
	const rows = await db.execute<{ release_tofu_state_lock: boolean }>(
		sql`select release_tofu_state_lock(${stateKey}, ${lockId}) as release_tofu_state_lock`,
	);
	return !!rows[0]?.release_tofu_state_lock;
}

/**
 * Force-releases a stranded state lock (staff/system only) — e.g. after a cancelled apply's
 * runner was hard-killed before it could UNLOCK. Rotates the lock_id + bumps the fencing
 * `generation` (never a naive delete) so a zombie writer from the killed apply is fenced out,
 * then expires the row so a fresh apply can acquire. Returns whether a lock existed.
 */
export async function forceReleaseStateLock(stateKey: string): Promise<boolean> {
	const db = getServiceDb();
	const rows = await db.execute<{ force_release_tofu_state_lock: boolean }>(
		sql`select force_release_tofu_state_lock(${stateKey}) as force_release_tofu_state_lock`,
	);
	return !!rows[0]?.force_release_tofu_state_lock;
}

/**
 * Releases any state lock still held by a job that has just gone terminal. Safe precisely because the
 * runner posts terminal only AFTER its tofu process has exited — so no live writer remains, just a
 * lock nobody will ever unlock (tofu's UNLOCK never arrives when it is killed: a cancel, an OOM, a
 * runner crash). Without this the lock strands for its full 3h TTL and every later job on that state
 * — the DESTROY sent to clean up the mess included — dies with "state already locked".
 *
 * Rotates + bumps the fencing `generation` rather than deleting the row, so even a zombie writer is
 * fenced out instead of corrupting state. Scoped strictly to locks THIS job holds. Returns how many
 * were released (normally 0 — tofu unlocked itself — or 1).
 */
export async function releaseStateLocksForJob(jobId: string): Promise<number> {
	const db = getServiceDb();
	const rows = await db.execute<{ released: number }>(
		sql`select release_tofu_state_locks_for_job(${jobId}::uuid) as released`,
	);
	return Number(rows[0]?.released ?? 0);
}

/** The fence: true iff a LIVE lock with this exact id is held for the state key. */
export async function validateStateLock(
	stateKey: string,
	lockId: string,
): Promise<boolean> {
	const db = getServiceDb();
	const rows = await db.execute<{ validate_tofu_state_lock: boolean }>(
		sql`select validate_tofu_state_lock(${stateKey}, ${lockId}) as validate_tofu_state_lock`,
	);
	return !!rows[0]?.validate_tofu_state_lock;
}
