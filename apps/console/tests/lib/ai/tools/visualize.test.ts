// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Unit tests for the generative-dashboard tool (lib/ai/tools/visualize.ts). Two things
// are asserted: (1) the `dashboardSpecSchema` discriminated union accepts each valid block
// kind (stat/bar/line/grid) and rejects malformed ones, and (2) `build_dashboard.execute`
// is a pure passthrough that returns the validated spec unchanged.

import { describe, expect, it } from "vitest";
import type { DashboardSpec } from "@/types/jsonb.types";
import { dashboardSpecSchema, visualizeTools } from "@/lib/ai/tools/visualize";

/** Invoke a `tool()`'s execute with throwaway ToolCallOptions (compose.test.ts idiom). */
const run = <T>(t: { execute?: unknown }, input: T) =>
	(t.execute as (i: T, o: unknown) => Promise<unknown>)(input, {
		toolCallId: "c1",
		messages: [],
	});

describe("dashboardSpecSchema — block kinds", () => {
	it("accepts a stat block (with and without the optional sub)", () => {
		expect(
			dashboardSpecSchema.safeParse({
				title: "Overview",
				blocks: [{ kind: "stat", title: "Clusters", value: 4, sub: "live" }],
			}).success,
		).toBe(true);
		expect(
			dashboardSpecSchema.safeParse({
				title: "Overview",
				blocks: [{ kind: "stat", title: "Spend", value: "$1,204" }],
			}).success,
		).toBe(true);
	});

	it("rejects a stat block with a missing value", () => {
		expect(
			dashboardSpecSchema.safeParse({
				title: "Overview",
				blocks: [{ kind: "stat", title: "Clusters" }],
			}).success,
		).toBe(false);
	});

	it("accepts a bar block of label/value pairs", () => {
		expect(
			dashboardSpecSchema.safeParse({
				title: "By provider",
				blocks: [
					{
						kind: "bar",
						title: "Jobs",
						data: [
							{ label: "aws", value: 12 },
							{ label: "gcp", value: 3 },
						],
					},
				],
			}).success,
		).toBe(true);
	});

	it("rejects a bar block whose datum value is non-numeric", () => {
		expect(
			dashboardSpecSchema.safeParse({
				title: "By provider",
				blocks: [{ kind: "bar", title: "Jobs", data: [{ label: "aws", value: "lots" }] }],
			}).success,
		).toBe(false);
	});

	it("accepts a line block of numeric points (label optional)", () => {
		expect(
			dashboardSpecSchema.safeParse({
				title: "Trend",
				blocks: [{ kind: "line", title: "Minutes", points: [1, 2, 3], label: "runner" }],
			}).success,
		).toBe(true);
	});

	it("rejects a line block whose points contain a non-number", () => {
		expect(
			dashboardSpecSchema.safeParse({
				title: "Trend",
				blocks: [{ kind: "line", title: "Minutes", points: [1, "two", 3] }],
			}).success,
		).toBe(false);
	});

	it("accepts a grid block of labelled cells", () => {
		expect(
			dashboardSpecSchema.safeParse({
				title: "Details",
				blocks: [
					{
						kind: "grid",
						title: "Plan",
						cells: [
							{ label: "Tier", value: "Team" },
							{ label: "Seats", value: 5 },
						],
					},
				],
			}).success,
		).toBe(true);
	});

	it("rejects an unknown block kind (discriminated union)", () => {
		expect(
			dashboardSpecSchema.safeParse({
				title: "Details",
				blocks: [{ kind: "pie", title: "Nope", value: 1 }],
			}).success,
		).toBe(false);
	});

	it("rejects a spec with no title", () => {
		expect(
			dashboardSpecSchema.safeParse({
				blocks: [{ kind: "stat", title: "x", value: 1 }],
			}).success,
		).toBe(false);
	});
});

describe("build_dashboard.execute", () => {
	it("returns the validated spec unchanged (pure passthrough)", async () => {
		const spec: DashboardSpec = {
			title: "Infrastructure",
			blocks: [
				{ kind: "stat", title: "Clusters", value: 4, sub: "live" },
				{ kind: "bar", title: "Jobs", data: [{ label: "aws", value: 12 }] },
				{ kind: "line", title: "Minutes", points: [10, 20, 30] },
				{ kind: "grid", title: "Plan", cells: [{ label: "Tier", value: "Team" }] },
			],
		};
		const out = await run(visualizeTools().build_dashboard, spec);
		expect(out).toBe(spec);
	});
});
