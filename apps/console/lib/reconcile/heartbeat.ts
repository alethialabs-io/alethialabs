// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Heartbeat seam for the supervised reconcile loop (lib/reconcile/loop.ts). Each reconciler task
// runs under `runTask`, which stamps last-run / last-success / last-error into an in-memory registry
// so a later /health endpoint + ops dashboard can read "is the B2c convergence layer ticking, and
// did the last pass of each reconciler succeed?" without a DB round-trip. The registry lives on
// globalThis so it survives Next HMR and is shared across every import in the process.
//
// It is deliberately process-local (not persisted): it answers liveness for THIS instance. Durable
// convergence itself is in the DB (the CAS, the ledgers) — this is the observability layer over it.

declare global {
	var __alethiaReconcileHeartbeats: Map<string, TaskHeartbeat> | undefined;
}

/** Liveness + last-outcome record for one reconciler task. */
export interface TaskHeartbeat {
	/** Stable task id, e.g. "env-convergence". */
	task: string;
	/** When the task last STARTED a run (ISO). */
	lastRunAt: string | null;
	/** When the task last completed WITHOUT throwing (ISO). */
	lastSuccessAt: string | null;
	/** When the task last threw (ISO). */
	lastErrorAt: string | null;
	/** The last error's message (null once it has since succeeded is NOT cleared — kept for forensics). */
	lastError: string | null;
	/** Wall-clock duration of the most recent run. */
	lastDurationMs: number | null;
	/** Total runs (success + failure) since process start. */
	runs: number;
	/** Total failed runs since process start. */
	failures: number;
	/** Optional structured result the task returned (e.g. counts), for the dashboard. */
	lastResult: Record<string, number> | null;
}

/** The shared registry (one entry per task id). */
function registry(): Map<string, TaskHeartbeat> {
	globalThis.__alethiaReconcileHeartbeats ??= new Map();
	return globalThis.__alethiaReconcileHeartbeats;
}

/** Get (or create) the heartbeat record for a task. */
function get(task: string): TaskHeartbeat {
	const reg = registry();
	let hb = reg.get(task);
	if (!hb) {
		hb = {
			task,
			lastRunAt: null,
			lastSuccessAt: null,
			lastErrorAt: null,
			lastError: null,
			lastDurationMs: null,
			runs: 0,
			failures: 0,
			lastResult: null,
		};
		reg.set(task, hb);
	}
	return hb;
}

/**
 * Run one reconciler task, stamping its heartbeat. Isolating each task means one reconciler
 * throwing never aborts its siblings in the same tick — the loop calls `runTask` per reconciler and
 * a rejection here is caught + recorded, not propagated. Returns the task's result (or undefined on
 * throw) so the loop can aggregate if it wants.
 */
export async function runTask<T extends Record<string, number> | void>(
	task: string,
	fn: () => Promise<T>,
): Promise<T | undefined> {
	const hb = get(task);
	const startedAt = Date.now();
	hb.lastRunAt = new Date(startedAt).toISOString();
	hb.runs += 1;
	try {
		const result = await fn();
		hb.lastDurationMs = Date.now() - startedAt;
		hb.lastSuccessAt = new Date().toISOString();
		hb.lastResult = result && typeof result === "object" ? result : null;
		return result;
	} catch (err) {
		hb.lastDurationMs = Date.now() - startedAt;
		hb.failures += 1;
		hb.lastErrorAt = new Date().toISOString();
		hb.lastError = err instanceof Error ? err.message : String(err);
		return undefined;
	}
}

/** Snapshot of every task's heartbeat (for /health + the ops dashboard). */
export function getHeartbeats(): TaskHeartbeat[] {
	return [...registry().values()].map((hb) => ({ ...hb }));
}

/**
 * Whether a task is due to run — true if it has never run or its last START was at least
 * `intervalMs` ago. Lets one supervised loop tick at a fixed cadence while each reconciler keeps its
 * own effective interval (convergence/reaper hot; GC cold), off the same heartbeat clock.
 */
export function isDue(task: string, intervalMs: number, now: Date = new Date()): boolean {
	const last = registry().get(task)?.lastRunAt;
	if (!last) return true;
	return now.getTime() - new Date(last).getTime() >= intervalMs;
}

/** Reset the registry — test-only (each test file wants a clean slate). */
export function __resetHeartbeats(): void {
	registry().clear();
}
