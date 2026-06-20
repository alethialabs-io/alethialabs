// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import postgres from "postgres";
import { getDatabaseConfig } from "@/lib/config/database";

// Realtime fan-out for job-log streaming over Postgres LISTEN/NOTIFY. The runner's
// insert_job_log() RPC does pg_notify('job_logs', {jobId, logId}); each app instance
// holds ONE dedicated LISTEN connection and dispatches to its SSE subscribers — so it
// scales to multiple instances with no Redis. The ee/ tier swaps a Redis-backed impl
// in behind this interface (RealtimeTransport seam, see spec/mvp/07-auth-rbac-sso.md).

export interface RealtimeTransport {
	/** Subscribe to new log ids for a job. Returns an unsubscribe function. */
	subscribe(jobId: string, cb: (logId: number) => void): () => void;
}

type LogCallback = (logId: number) => void;

class PgListenTransport implements RealtimeTransport {
	private readonly listeners = new Map<string, Set<LogCallback>>();
	private started = false;
	private sql: ReturnType<typeof postgres> | null = null;

	/** Lazily opens the single LISTEN connection on first subscribe. */
	private ensureStarted(): void {
		if (this.started) return;
		this.started = true;
		this.sql = postgres(getDatabaseConfig().serviceUrl, {
			max: 1,
			prepare: false,
		});
		this.sql
			.listen("job_logs", (payload) => {
				let parsed: { jobId?: string; logId?: number | string };
				try {
					parsed = JSON.parse(payload);
				} catch {
					return; // ignore malformed payloads
				}
				if (!parsed.jobId || parsed.logId === undefined) return;
				const subs = this.listeners.get(parsed.jobId);
				if (!subs) return;
				const logId = Number(parsed.logId);
				for (const cb of subs) cb(logId);
			})
			.catch((err) => {
				console.error("[realtime] LISTEN job_logs failed:", err);
				this.started = false; // allow a retry on the next subscribe
			});
	}

	subscribe(jobId: string, cb: LogCallback): () => void {
		this.ensureStarted();
		let set = this.listeners.get(jobId);
		if (!set) {
			set = new Set();
			this.listeners.set(jobId, set);
		}
		set.add(cb);
		return () => {
			const current = this.listeners.get(jobId);
			if (!current) return;
			current.delete(cb);
			if (current.size === 0) this.listeners.delete(jobId);
		};
	}
}

const globalForRealtime = globalThis as unknown as {
	__alethiaRealtime?: RealtimeTransport;
};

/** The process-wide realtime transport (HMR/instance-safe singleton). */
export function getRealtimeTransport(): RealtimeTransport {
	if (!globalForRealtime.__alethiaRealtime) {
		globalForRealtime.__alethiaRealtime = new PgListenTransport();
	}
	return globalForRealtime.__alethiaRealtime;
}
