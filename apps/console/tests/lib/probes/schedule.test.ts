// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
	type ProbeCandidate,
	PROBE_CADENCE_MS,
	selectDueForProbe,
	shouldAlertUnreachable,
	tierForStage,
} from "@/lib/probes/schedule";

const NOW = new Date("2026-07-14T12:00:00Z");

function cand(
	id: string,
	tier: ProbeCandidate["tier"],
	lastCheckedAt: Date | null,
): ProbeCandidate {
	return { environmentId: id, projectId: "p", tier, lastCheckedAt };
}

describe("PROBE_CADENCE_MS", () => {
	it("is far tighter than drift — prod 10m / staging 1h / dev 6h", () => {
		expect(PROBE_CADENCE_MS.prod).toBe(10 * 60_000);
		expect(PROBE_CADENCE_MS.staging).toBe(60 * 60_000);
		expect(PROBE_CADENCE_MS.dev).toBe(6 * 60 * 60_000);
	});
});

describe("tierForStage (shared with drift)", () => {
	it("maps stages to cadence tiers", () => {
		expect(tierForStage("production")).toBe("prod");
		expect(tierForStage("staging")).toBe("staging");
		expect(tierForStage("development")).toBe("dev");
		expect(tierForStage(null)).toBe("dev");
	});
});

describe("selectDueForProbe", () => {
	it("includes never-probed environments", () => {
		const due = selectDueForProbe([cand("a", "prod", null)], NOW);
		expect(due.map((d) => d.environmentId)).toEqual(["a"]);
	});

	it("includes envs past their tier cadence and excludes fresh ones", () => {
		const justNow = new Date(NOW.getTime() - 60_000); // 1 min ago
		const staleProd = new Date(NOW.getTime() - PROBE_CADENCE_MS.prod - 1000);
		const due = selectDueForProbe(
			[cand("fresh", "prod", justNow), cand("stale", "prod", staleProd)],
			NOW,
		);
		expect(due.map((d) => d.environmentId)).toEqual(["stale"]);
	});

	it("respects per-tier cadence (a prod-stale gap is fresh for staging)", () => {
		// 15m is past prod's 10m cadence but well within staging's 1h cadence.
		const fifteenMinAgo = new Date(NOW.getTime() - 15 * 60_000);
		const dueProd = selectDueForProbe([cand("x", "prod", fifteenMinAgo)], NOW);
		const dueStaging = selectDueForProbe(
			[cand("x", "staging", fifteenMinAgo)],
			NOW,
		);
		expect(dueProd).toHaveLength(1);
		expect(dueStaging).toHaveLength(0);
	});

	it("treats an exactly-at-cadence gap as due (>=)", () => {
		const exactly = new Date(NOW.getTime() - PROBE_CADENCE_MS.prod);
		expect(selectDueForProbe([cand("x", "prod", exactly)], NOW)).toHaveLength(1);
	});
});

describe("shouldAlertUnreachable — fires ONLY on true→false", () => {
	it("alerts on true→false (cluster just went dark)", () => {
		expect(shouldAlertUnreachable(true, false)).toBe(true);
	});

	it("does NOT alert on first-ever-false (null→false, never proven alive)", () => {
		expect(shouldAlertUnreachable(null, false)).toBe(false);
	});

	it("does NOT alert on false→false (still down, already alerted)", () => {
		expect(shouldAlertUnreachable(false, false)).toBe(false);
	});

	it("does NOT alert on true→true (healthy)", () => {
		expect(shouldAlertUnreachable(true, true)).toBe(false);
	});

	it("does NOT alert on false→true (recovery, not an outage)", () => {
		expect(shouldAlertUnreachable(false, true)).toBe(false);
	});

	it("does NOT alert on null→true (first probe, healthy)", () => {
		expect(shouldAlertUnreachable(null, true)).toBe(false);
	});
});
