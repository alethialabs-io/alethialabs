// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The shape the page and its consumers see, and the two decisions that keep the Worker inside
 * Cloudflare's free tier without going stale.
 *
 * Everything here is PURE. D1 and KV access lives in `worker.ts`; this file is the part worth
 * testing, so it is the part with no I/O in it.
 */

import type { Health, OverallState } from "./probes";

/** Bumped only on a breaking change to the payload. Consumers pin it. */
export const SUMMARY_VERSION = 1;

/** One component as the page and /api/summary.json report it. */
export interface ComponentSummary {
	id: string;
	name: string;
	description: string;
	health: Health;
	/** Why it is not up. Null when it is. */
	reason: string | null;
	/** Last response time in ms. Null when the fetch never completed. */
	ms: number | null;
	/** Fraction of successful checks over the retained window, or null if no history yet. */
	uptime90d: number | null;
	/** Oldest day first. Drives the uptime bar. */
	history: DayRollup[];
}

/** One component's checks on one UTC day. */
export interface DayRollup {
	day: string;
	total: number;
	up: number;
}

/** One incident, open or resolved. */
export interface IncidentSummary {
	id: number;
	component: string;
	componentName: string;
	startedAt: string;
	resolvedAt: string | null;
	worst: Health;
	reason: string | null;
}

/** The whole public payload. */
export interface Summary {
	version: number;
	generatedAt: string;
	state: OverallState;
	components: ComponentSummary[];
	incidents: IncidentSummary[];
}

// ── KV write gating ─────────────────────────────────────────────────────────

/**
 * Cloudflare's free plan allows **1000 KV writes per day**. A snapshot written every 60s is 1440 —
 * over the limit, so the page would stop updating partway through each day. Writing only when
 * something CHANGED (plus a periodic refresh so `generatedAt` cannot look frozen) lands around
 * 150/day.
 *
 * D1 takes the per-minute history instead: its free allowance is 100k row writes a day, which seven
 * components a minute (~20k) sits comfortably inside.
 */
export const FORCED_REFRESH_MS = 10 * 60 * 1000;

/**
 * What "changed" means: the health, the reason, and which incidents are open.
 *
 * Response times and timestamps are deliberately EXCLUDED. They change on every cycle, so including
 * them would make the gate always fire and quietly put us back over the write limit — the bug this
 * function exists to prevent.
 */
export function snapshotHash(s: Pick<Summary, "state" | "components" | "incidents">): string {
	const parts = [
		s.state,
		...s.components.map((c) => `${c.id}:${c.health}:${c.reason ?? ""}`),
		...s.incidents.filter((i) => i.resolvedAt === null).map((i) => `open:${i.id}`),
	];
	return fnv1a(parts.join("|"));
}

/** Whether to write a new snapshot: on the first write, on any change, or once the refresh interval has passed. */
export function shouldWriteSnapshot(args: {
	previousHash: string | null;
	nextHash: string;
	lastWrittenAtMs: number | null;
	nowMs: number;
}): boolean {
	if (args.previousHash === null || args.lastWrittenAtMs === null) return true;
	if (args.previousHash !== args.nextHash) return true;
	return args.nowMs - args.lastWrittenAtMs >= FORCED_REFRESH_MS;
}

/** FNV-1a. Sync, dependency-free, and plenty for "did this string change". */
function fnv1a(input: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < input.length; i++) {
		h ^= input.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16);
}

// ── incident transitions ────────────────────────────────────────────────────

/**
 * A single failed probe is not an incident.
 *
 * One missed check is indistinguishable from a deploy, a container restart or a network hiccup at the
 * probing edge, and a page that opens an incident for each of those trains people to ignore it. Two
 * in a row (≥60s of sustained failure) is the smallest window that rules those out. Recovery needs
 * two in a row for the same reason: one green check in the middle of a flap is not a resolution.
 */
export const FAIL_THRESHOLD = 2;
export const RECOVER_THRESHOLD = 2;

/** What the incident state machine decided for one component this cycle. */
export type IncidentAction =
	| { kind: "open"; worst: Health; reason: string | null }
	| { kind: "escalate"; worst: Health; reason: string | null }
	| { kind: "resolve" }
	| { kind: "none" };

/**
 * Decide the incident transition for one component. `recent` is newest-first and includes the cycle
 * just probed.
 *
 * `degraded` counts as failing: the endpoint answered, but not in the state it must be in, and that
 * is exactly the case a status-code check cannot see.
 */
export function decideIncident(args: {
	recent: { health: Health; reason: string | null }[];
	openIncident: { worst: Health } | null;
}): IncidentAction {
	const { recent, openIncident } = args;
	const current = recent[0];
	if (!current) return { kind: "none" };

	const failing = (h: Health): boolean => h !== "up";
	const runOf = (predicate: (h: Health) => boolean): number => {
		let n = 0;
		for (const r of recent) {
			if (!predicate(r.health)) break;
			n++;
		}
		return n;
	};

	if (openIncident) {
		if (runOf((h) => h === "up") >= RECOVER_THRESHOLD) return { kind: "resolve" };
		// `down` is worse than `degraded`; an incident that starts degraded and deepens should say so
		// rather than keep reporting the milder first reading.
		if (current.health === "down" && openIncident.worst !== "down") {
			return { kind: "escalate", worst: "down", reason: current.reason };
		}
		return { kind: "none" };
	}

	if (failing(current.health) && runOf(failing) >= FAIL_THRESHOLD) {
		return { kind: "open", worst: current.health, reason: current.reason };
	}
	return { kind: "none" };
}

// ── uptime ──────────────────────────────────────────────────────────────────

/** The up fraction across days. Null rather than 1 when there is no history — "no data" is not "perfect". */
export function uptimeFraction(history: DayRollup[]): number | null {
	let total = 0;
	let up = 0;
	for (const d of history) {
		total += d.total;
		up += d.up;
	}
	return total === 0 ? null : up / total;
}
