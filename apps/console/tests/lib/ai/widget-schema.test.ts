// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The widget pin path and the artifact widget used to declare the `{ output?, block? }` data shape
// twice, with nothing tying the copies together (#5683). They now share ONE schema object. These
// pin that sharing structurally (identity, so a re-declared copy fails even while it still agrees)
// and behaviourally (both paths accept and reject the same payloads).

import { describe, expect, it } from "vitest";
import { artifactWidgetSchema } from "@/lib/ai/artifact-spec";
import { pinInputSchema, widgetDataSchema } from "@/lib/ai/widget-schema";

const PIN = {
	threadId: "11111111-1111-4111-8111-111111111111",
	kind: "stat",
	title: "Clusters",
	posX: 0,
	posY: 0,
	colspan: 1,
	rowspan: 1,
	mode: "frozen",
};

const ARTIFACT_WIDGET = {
	kind: "stat",
	title: "Clusters",
	source: null,
	mode: "frozen",
	position: { x: 0, y: 0 },
	size: { colspan: 1, rowspan: 1 },
};

const ACCEPTED: ReadonlyArray<readonly [string, unknown]> = [
	["an empty payload", {}],
	["a stat block", { block: { kind: "stat", title: "Clusters", value: 3 } }],
	["a raw tool output", { output: { rows: [1, 2, 3] } }],
	["both output and block", { output: null, block: { kind: "stat", title: "x", value: "1" } }],
];

const REJECTED: ReadonlyArray<readonly [string, unknown]> = [
	["a block of an unknown kind", { block: { kind: "pie", title: "x" } }],
	["a stat block missing its value", { block: { kind: "stat", title: "x" } }],
	["a non-object payload", "frozen"],
];

describe("widget data — one schema for the pin path and the artifact widget", () => {
	it("the pin's data IS the artifact widget's data schema, not a copy of it", () => {
		expect(widgetDataSchema).toBe(artifactWidgetSchema.shape.data);
		expect(pinInputSchema.shape.data.unwrap()).toBe(artifactWidgetSchema.shape.data);
	});

	it.each(ACCEPTED)("both paths accept %s", (_label, data) => {
		expect(pinInputSchema.safeParse({ ...PIN, data }).success).toBe(true);
		expect(artifactWidgetSchema.safeParse({ ...ARTIFACT_WIDGET, data }).success).toBe(true);
	});

	it.each(REJECTED)("both paths reject %s", (_label, data) => {
		expect(pinInputSchema.safeParse({ ...PIN, data }).success).toBe(false);
		expect(artifactWidgetSchema.safeParse({ ...ARTIFACT_WIDGET, data }).success).toBe(false);
	});

	it("a pin may omit data entirely; an artifact widget may not", () => {
		expect(pinInputSchema.safeParse(PIN).success).toBe(true);
		expect(artifactWidgetSchema.safeParse(ARTIFACT_WIDGET).success).toBe(false);
	});
});

describe("pinInputSchema — placement and identity bounds", () => {
	it.each([
		["a non-uuid threadId", { threadId: "not-a-uuid" }],
		["an unknown kind", { kind: "pie" }],
		["an empty title", { title: "" }],
		["a title over 120 characters", { title: "t".repeat(121) }],
		["posX past the 5-column grid", { posX: 5 }],
		["a negative posY", { posY: -1 }],
		["colspan 0", { colspan: 0 }],
		["colspan past the grid", { colspan: 6 }],
		["rowspan over 12", { rowspan: 13 }],
		["a fractional posX", { posX: 1.5 }],
		["an unknown mode", { mode: "paused" }],
	])("rejects %s", (_label, override) => {
		expect(pinInputSchema.safeParse({ ...PIN, ...override }).success).toBe(false);
	});

	it("accepts a live pin with a replayable source and a dedupe key", () => {
		const live = {
			...PIN,
			mode: "live",
			source: { tool: "list_clusters", args: { status: "ready" } },
			toolCallId: "call-1",
		};
		expect(pinInputSchema.safeParse(live).success).toBe(true);
	});
});
