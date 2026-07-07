// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Unit tests for the org sidebar nav model: the primary shell only advertises surfaces we
// ship (no "Soon" stubs, no removed pages), and Runners is gated behind self-operator orgs.

import { describe, expect, it } from "vitest";
import { buildDrills, buildSidebarNav } from "@/components/shell/nav-config";

/** All nav labels across the three groups, for membership assertions. */
function labels(orgSlug: string, opts?: { selfRunners?: boolean }): string[] {
	const g = buildSidebarNav(orgSlug, opts);
	return [...g.top, ...g.connect, ...g.pinned].map((i) => i.label);
}

describe("buildSidebarNav", () => {
	it("drops the retired Observability and Sandboxes surfaces", () => {
		const all = labels("acme");
		expect(all).not.toContain("Observability");
		expect(all).not.toContain("Sandboxes");
	});

	it("surfaces Evidence as a top-level route", () => {
		const g = buildSidebarNav("acme");
		expect(g.top).toContainEqual(
			expect.objectContaining({
				label: "Evidence",
				sub: "evidence",
				href: "/acme/~/evidence",
			}),
		);
	});

	it("keeps the surfaces we ship", () => {
		expect(labels("acme")).toEqual(
			expect.arrayContaining([
				"Overview",
				"Clusters",
				"Jobs",
				"Evidence",
				"Connectors",
				"Alerts",
				"Agent",
				"Usage",
				"Support",
				"Settings",
			]),
		);
	});

	it("gates Runners on self-operated runners", () => {
		expect(labels("acme")).not.toContain("Runners");
		expect(labels("acme", { selfRunners: false })).not.toContain("Runners");
		expect(labels("acme", { selfRunners: true })).toContain("Runners");
	});

	it("has no disabled (Soon) items in the primary nav", () => {
		const g = buildSidebarNav("acme", { selfRunners: true });
		const disabled = [...g.top, ...g.connect, ...g.pinned].filter(
			(i) => i.disabled,
		);
		expect(disabled).toEqual([]);
	});
});

describe("buildDrills", () => {
	it("no longer defines an observability drill", () => {
		const drills = buildDrills("acme");
		expect("observability" in drills).toBe(false);
		expect(Object.keys(drills).sort()).toEqual(["alerts", "settings"]);
	});
});
