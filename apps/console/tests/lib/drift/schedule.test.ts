// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
	type DriftCandidate,
	DRIFT_CADENCE_MS,
	selectDueForDrift,
	tierForStage,
} from "@/lib/drift/schedule";

const NOW = new Date("2026-06-29T12:00:00Z");

function cand(
	id: string,
	tier: DriftCandidate["tier"],
	lastCheckedAt: Date | null,
): DriftCandidate {
	return { environmentId: id, projectId: "p", tier, lastCheckedAt };
}

describe("tierForStage", () => {
	it("maps stages to cadence tiers", () => {
		expect(tierForStage("production")).toBe("prod");
		expect(tierForStage("prod")).toBe("prod");
		expect(tierForStage("staging")).toBe("staging");
		expect(tierForStage("development")).toBe("dev");
		expect(tierForStage(null)).toBe("dev");
	});
});

describe("selectDueForDrift", () => {
	it("includes never-checked environments", () => {
		const due = selectDueForDrift([cand("a", "prod", null)], NOW);
		expect(due.map((d) => d.environmentId)).toEqual(["a"]);
	});

	it("includes environments past their tier cadence and excludes fresh ones", () => {
		const justNow = new Date(NOW.getTime() - 60_000); // 1 min ago
		const staleProd = new Date(NOW.getTime() - DRIFT_CADENCE_MS.prod - 1000);
		const due = selectDueForDrift(
			[
				cand("fresh", "prod", justNow),
				cand("stale", "prod", staleProd),
			],
			NOW,
		);
		expect(due.map((d) => d.environmentId)).toEqual(["stale"]);
	});

	it("respects per-tier cadence (a prod-stale gap is fresh for dev)", () => {
		const sixHoursAgo = new Date(NOW.getTime() - DRIFT_CADENCE_MS.prod - 1000);
		// 6h is past prod cadence but well within dev's 7-day cadence.
		const dueProd = selectDueForDrift([cand("x", "prod", sixHoursAgo)], NOW);
		const dueDev = selectDueForDrift([cand("x", "dev", sixHoursAgo)], NOW);
		expect(dueProd).toHaveLength(1);
		expect(dueDev).toHaveLength(0);
	});
});
