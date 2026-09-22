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
		// Runner minutes render through `formatMinutes` (@repo/format) on BOTH sides of the
		// slash — the raw `12 / 200` here was the agent widget's own divergent rendering.
		expectText: "12 min / 3h 20m",
	},
	get_ai_usage: {
		output: { tier: "ai_free", session_used: 3, session_budget: 10, weekly_used: 5, weekly_budget: 50, purchased_balance: 0 },
		expectText: "ai_free",
	},
	// DELIBERATELY THE PRE-#4176 SHAPE — `unit_amount_usd` alone, no `unit_amount`/`currency`
	// pair. This is exactly what `thread_widgets.data` holds for every billing widget pinned
	// before part (b), and the fixture exists to prove those rows still parse and still render.
	// The currency half is covered by its own case below.
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

	// ── THE BILLING WIDGET'S TWO SNAPSHOT SHAPES (#4176 part b) ─────────────────────────────
	//
	// A widget's output is PERSISTED (`thread_widgets.data`), so the tool's wire shape has a
	// second reader that no amount of type-checking reaches: rows written months ago. The
	// registry has to render both, and "both" is not a thing one fixture can assert.
	describe("get_billing_summary — old and new snapshots both render their amount", () => {
		const def = WIDGET_REGISTRY.get_billing_summary;
		const base = { plan: "team", status: "active", seats: 5, member_count: 3, current_period_end: "2026-08-01" };

		it("renders a pre-pair snapshot from the deprecated USD field", () => {
			if (!def) throw new Error("no get_billing_summary widget");
			render(<def.Body output={{ ...base, unit_amount_usd: 20 }} />);
			expect(screen.getByText("$20.00")).toBeInTheDocument();
		});

		it("prefers the currency-carrying pair, and a EUR amount renders in euros", () => {
			if (!def) throw new Error("no get_billing_summary widget");
			render(<def.Body output={{ ...base, unit_amount: 1800, currency: "eur" }} />);
			expect(screen.getByText("€18.00")).toBeInTheDocument();
		});

		// THE PREFERENCE ORDER ITSELF. A snapshot carrying both — which is what a row written
		// after part (b) looks like — must read the pair, not the deprecated field. Without this
		// case, a `seatAmount` that checked `unit_amount_usd` first would pass both cases above.
		it("reads the pair, not the deprecated field, when a snapshot carries both", () => {
			if (!def) throw new Error("no get_billing_summary widget");
			render(<def.Body output={{ ...base, unit_amount: 1800, currency: "eur", unit_amount_usd: 20 }} />);
			expect(screen.getByText("€18.00")).toBeInTheDocument();
			expect(screen.queryByText("$20.00")).not.toBeInTheDocument();
		});
	});

	it("maps part types to entries and sizes blocks by kind", () => {
		expect(widgetDefForPartType("tool-list_jobs")?.title).toBe("Jobs");
		expect(widgetDefForPartType("reasoning")).toBeUndefined();
		expect(blockDefaultSize("stat")).toEqual({ colspan: 1, rowspan: 1 });
		expect(blockDefaultSize("line")).toEqual({ colspan: 2, rowspan: 1 });
		expect(blockDefaultSize("bar")).toEqual({ colspan: 2, rowspan: 2 });
	});
});
