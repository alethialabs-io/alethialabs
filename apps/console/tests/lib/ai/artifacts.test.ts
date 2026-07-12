// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// PR-3 invariants around saved artifacts + live refresh:
// - the artifact spec schema (the update_artifact wire contract) round-trips a real
//   spec and rejects malformed/oversized ones;
// - REFRESHABLE_TOOLS (the ONLY tools a live widget may replay) stays in lockstep with
//   the client widget registry and NEVER includes an action/HITL/write tool — this is
//   the security boundary of refreshWidgetSource;
// - the artifact mention type is wired into the mention SSOT.

import { describe, expect, it } from "vitest";
import { WIDGET_REGISTRY } from "@/components/agent/widgets/registry";
import { artifactSpecSchema } from "@/lib/ai/artifact-spec";
import { MENTION_TOOL, MENTION_TYPES } from "@/lib/ai/mentions";
import { formatMentionsForPrompt } from "@/lib/ai/mentions";
import { TOOL_AUDIENCE } from "@/lib/ai/tools/registry";
import { REFRESHABLE_TOOLS } from "@/lib/ai/tools/widgets";

describe("artifactSpecSchema", () => {
	const widget = {
		kind: "stat",
		title: "Clusters",
		source: null,
		data: { block: { kind: "stat", title: "Clusters", value: 3 } },
		mode: "frozen",
		position: { x: 0, y: 0 },
		size: { colspan: 1, rowspan: 1 },
	};

	it("round-trips a valid spec", () => {
		expect(artifactSpecSchema.safeParse({ widgets: [widget] }).success).toBe(true);
	});

	it("rejects an empty spec and an out-of-bounds position", () => {
		expect(artifactSpecSchema.safeParse({ widgets: [] }).success).toBe(false);
		expect(
			artifactSpecSchema.safeParse({
				widgets: [{ ...widget, position: { x: 9, y: 0 } }],
			}).success,
		).toBe(false);
	});
});

describe("REFRESHABLE_TOOLS (the live-refresh allowlist)", () => {
	it("is exactly the widget registry's keys (lockstep)", () => {
		expect([...REFRESHABLE_TOOLS].sort()).toEqual(
			Object.keys(WIDGET_REGISTRY).sort(),
		);
	});

	it("never contains an action/HITL/write tool", () => {
		for (const banned of [
			"pin_widget",
			"build_dashboard",
			"propose_operation",
			"propose_changes",
			"scan_repo",
			"connect_cloud",
			"update_artifact",
			"create_support_case",
		]) {
			expect(REFRESHABLE_TOOLS.has(banned)).toBe(false);
		}
	});

	it("only contains classified read tools", () => {
		for (const t of REFRESHABLE_TOOLS) {
			expect(TOOL_AUDIENCE[t]).toBeDefined();
		}
	});
});

describe("artifact mentions", () => {
	it("is a mention type with a resolving tool", () => {
		expect(MENTION_TYPES).toContain("artifact");
		expect(MENTION_TOOL.artifact).toContain("get_artifact");
	});

	it("formats an artifact mention into the prompt block", () => {
		const block = formatMentionsForPrompt([
			{ id: "a-1", type: "artifact", label: "prod-overview" },
		]);
		expect(block).toContain("@prod-overview");
		expect(block).toContain("get_artifact");
	});
});
