// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The tool→widget registry is the SSOT both the transcript and the grid render
// through — these tests feed every entry a representative fixture and assert it
// parses + its Body renders real content, and that malformed output is rejected
// (parses false, Body renders nothing) so callers fall back to generic treatment.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
	blockDefaultSize,
	WIDGET_REGISTRY,
	widgetDefForPartType,
} from "@/components/agent/widgets/registry";

/** A representative valid output per registry tool. */
const FIXTURES: Record<string, { output: unknown; expectText: string }> = {
	list_projects: {
		output: {
			projects: [
				{ id: "p1", name: "api", environment: "prod", region: "eu-central-1", status: "ready" },
			],
		},
		expectText: "api",
	},
	list_jobs: {
		output: { jobs: [{ id: "j1", type: "PLAN", project: "api", provider: "aws", status: "done" }] },
		expectText: "PLAN",
	},
	list_clusters: {
		output: {
			clusters: [{ id: "c1", name: "prod-eks", region: "eu-central-1", provider: "aws", status: "up" }],
		},
		expectText: "prod-eks",
	},
	list_connectors: {
		output: { connectors: [{ slug: "aws", name: "Amazon Web Services", category: "cloud", status: "active", connected: true }] },
		expectText: "Amazon Web Services",
	},
	list_runners: {
		output: { runners: [{ id: "r1", name: "runner-1", operator: "managed", status: "idle", online: true }] },
		expectText: "runner-1",
	},
	get_org_usage: {
		output: {
			plan: "community",
			used_minutes: 12,
			included_minutes: 200,
			overage_minutes: 0,
			overage_cost_usd: 0,
			running_jobs: 1,
			max_concurrent_jobs: 2,
		},
		expectText: "12 / 200",
	},
	get_ai_usage: {
		output: { tier: "ai_free", session_used: 3, session_budget: 10, weekly_used: 5, weekly_budget: 50, purchased_balance: 0 },
		expectText: "ai_free",
	},
	get_billing_summary: {
		output: { plan: "team", status: "active", seats: 5, member_count: 3, unit_amount_usd: 20, current_period_end: "2026-08-01" },
		expectText: "team",
	},
	get_drift_posture: {
		output: { status: "ok", in_sync: false, drifted: 2, scanned_at: "2026-07-12" },
		expectText: "Drifted resources",
	},
};

describe("WIDGET_REGISTRY", () => {
	it("covers every fixture and every entry has a fixture (keep them in lockstep)", () => {
		expect(Object.keys(FIXTURES).sort()).toEqual(Object.keys(WIDGET_REGISTRY).sort());
	});

	for (const [tool, fixture] of Object.entries(FIXTURES)) {
		it(`${tool}: parses its fixture and renders its body`, () => {
			const def = WIDGET_REGISTRY[tool];
			expect(def).toBeDefined();
			if (!def) return;
			expect(def.parses(fixture.output)).toBe(true);
			render(<def.Body output={fixture.output} />);
			expect(screen.getByText(fixture.expectText, { exact: false })).toBeInTheDocument();
		});

		it(`${tool}: rejects malformed output`, () => {
			const def = WIDGET_REGISTRY[tool];
			if (!def) return;
			expect(def.parses({ nope: true })).toBe(false);
			const { container } = render(<def.Body output={{ nope: true }} />);
			expect(container).toBeEmptyDOMElement();
		});
	}

	it("maps part types to entries and sizes blocks by kind", () => {
		expect(widgetDefForPartType("tool-list_jobs")?.title).toBe("Jobs");
		expect(widgetDefForPartType("reasoning")).toBeUndefined();
		expect(blockDefaultSize("stat")).toEqual({ colspan: 1, rowspan: 1 });
		expect(blockDefaultSize("line")).toEqual({ colspan: 2, rowspan: 1 });
		expect(blockDefaultSize("bar")).toEqual({ colspan: 2, rowspan: 2 });
	});
});
