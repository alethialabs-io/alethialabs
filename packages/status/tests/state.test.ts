// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import type { Health } from "../src/probes";
import {
	FORCED_REFRESH_MS,
	decideIncident,
	shouldWriteSnapshot,
	snapshotHash,
	uptimeFraction,
	type ComponentSummary,
	type IncidentSummary,
	type Summary,
} from "../src/state";

/** A component in a given health, with a response time that should never matter to the hash. */
function component(id: string, health: Health, ms = 100, reason: string | null = null): ComponentSummary {
	return { id, name: id, description: "", health, reason, ms, uptime90d: 1, history: [] };
}

/** An incident, open unless `resolvedAt` is given. */
function incident(id: number, resolvedAt: string | null = null): IncidentSummary {
	return {
		id,
		component: "database",
		componentName: "Database",
		startedAt: "2026-11-21T10:00:00.000Z",
		resolvedAt,
		worst: "down",
		reason: null,
	};
}

/** The hashed part of a summary. */
function snap(over: Partial<Summary> = {}): Pick<Summary, "state" | "components" | "incidents"> {
	return {
		state: "operational",
		components: [component("console", "up"), component("database", "up")],
		incidents: [],
		...over,
	};
}

const MINUTE = 60_000;

describe("KV write gating — the 1000 writes/day free-tier ceiling", () => {
	it("writes when there is no previous snapshot", () => {
		expect(shouldWriteSnapshot({ previousHash: null, nextHash: "a", lastWrittenAtMs: null, nowMs: 0 })).toBe(true);
	});

	it("writes when a component's health changes", () => {
		const before = snapshotHash(snap());
		const after = snapshotHash(snap({ components: [component("console", "up"), component("database", "down")] }));
		expect(after).not.toBe(before);
	});

	it("writes when an incident opens", () => {
		expect(snapshotHash(snap({ incidents: [incident(1)] }))).not.toBe(snapshotHash(snap()));
	});

	it("does NOT write when only response time moved", () => {
		const a = snapshotHash(snap({ components: [component("console", "up", 100), component("database", "up", 40)] }));
		const b = snapshotHash(snap({ components: [component("console", "up", 900), component("database", "up", 7)] }));
		expect(a).toBe(b);
		expect(shouldWriteSnapshot({ previousHash: a, nextHash: b, lastWrittenAtMs: 0, nowMs: MINUTE })).toBe(false);
	});

	it("a resolved incident does not keep re-triggering writes", () => {
		expect(snapshotHash(snap({ incidents: [incident(1, "2026-11-21T10:30:00.000Z")] }))).toBe(snapshotHash(snap()));
	});

	it("forces a refresh once the interval has passed, so generatedAt cannot look frozen", () => {
		const h = snapshotHash(snap());
		expect(shouldWriteSnapshot({ previousHash: h, nextHash: h, lastWrittenAtMs: 0, nowMs: FORCED_REFRESH_MS })).toBe(
			true,
		);
	});

	it("a full day of unchanged cycles stays far under the 1000-write limit", () => {
		const h = snapshotHash(snap());
		let writes = 0;
		let last: number | null = null;
		let prev: string | null = null;
		for (let t = 0; t < 1440 * MINUTE; t += MINUTE) {
			if (shouldWriteSnapshot({ previousHash: prev, nextHash: h, lastWrittenAtMs: last, nowMs: t })) {
				writes++;
				last = t;
				prev = h;
			}
		}
		expect(writes).toBeLessThanOrEqual(150);
	});
});

/** Newest-first history from a list of healths given oldest-first, as a reader writes them. */
function recent(...oldestFirst: Health[]): { health: Health; reason: string | null }[] {
	return oldestFirst.map((health) => ({ health, reason: health === "up" ? null : `was ${health}` })).reverse();
}

describe("incident transitions — open after 2 fails, close after 2 recoveries", () => {
	it("does not open an incident for a single blip", () => {
		expect(decideIncident({ recent: recent("up", "down"), openIncident: null })).toEqual({ kind: "none" });
	});

	it("opens on two consecutive failures", () => {
		expect(decideIncident({ recent: recent("up", "down", "down"), openIncident: null })).toEqual({
			kind: "open",
			worst: "down",
			reason: "was down",
		});
	});

	it("treats DEGRADED as failing — a 200 that says degraded must still open an incident", () => {
		expect(decideIncident({ recent: recent("degraded", "degraded"), openIncident: null }).kind).toBe("open");
	});

	it("escalates a degraded incident that becomes down, once", () => {
		expect(decideIncident({ recent: recent("degraded", "down"), openIncident: { worst: "degraded" } }).kind).toBe(
			"escalate",
		);
		expect(decideIncident({ recent: recent("degraded", "down"), openIncident: { worst: "down" } }).kind).toBe("none");
	});

	it("holds an open incident through a single good check", () => {
		expect(decideIncident({ recent: recent("down", "down", "up"), openIncident: { worst: "down" } }).kind).toBe("none");
	});

	it("resolves after two consecutive good checks", () => {
		expect(decideIncident({ recent: recent("down", "up", "up"), openIncident: { worst: "down" } }).kind).toBe(
			"resolve",
		);
	});

	it("does nothing on an empty history rather than inventing a state", () => {
		expect(decideIncident({ recent: [], openIncident: null })).toEqual({ kind: "none" });
	});
});

describe("uptime", () => {
	it("is null with no history — 'no data' is not 'perfect'", () => {
		expect(uptimeFraction([])).toBeNull();
	});

	it("sums across days rather than averaging the daily rates", () => {
		expect(
			uptimeFraction([
				{ day: "2026-11-20", total: 10, up: 0 },
				{ day: "2026-11-21", total: 1430, up: 1430 },
			]),
		).toBeCloseTo(1430 / 1440);
	});
});
