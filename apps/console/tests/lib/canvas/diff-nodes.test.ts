// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The staged-change list: what the pending-changes bar counts and what Deploy claims to change
// (#6762). It is a pure function of the saved baseline and the draft, pinned here over hand-built
// nodes — including what must NEVER appear in it.

import { describe, expect, it } from "vitest";
import type { CanvasNode } from "@/components/design-project/canvas/graph/types";
import { diffNodes } from "@/lib/stores/use-canvas-store";
import {
	addonNode,
	cacheNode,
	chartNode,
	chartWorkloadNode,
	databaseNode,
	externalNode,
	projectNode,
} from "@/tests/fixtures/canvas/nodes";

/** The saved design every case starts from. */
function baseline(): CanvasNode[] {
	return [projectNode(), databaseNode("orders"), cacheNode("sessions")];
}

describe("diffNodes", () => {
	it("reports nothing when the draft is the baseline", () => {
		expect(diffNodes(baseline(), baseline())).toEqual([]);
	});

	it("reports a node the baseline lacks as new", () => {
		expect(diffNodes(baseline(), [...baseline(), databaseNode("invoices")])).toEqual([
			{ id: "database-invoices", op: "new", kind: "database", name: "invoices" },
		]);
	});

	it("reports a node whose config changed as modified", () => {
		const draft = [projectNode(), databaseNode("orders", 6543), cacheNode("sessions")];
		expect(diffNodes(baseline(), draft)).toEqual([
			{ id: "database-orders", op: "modified", kind: "database", name: "orders" },
		]);
	});

	it("reports a node the draft lacks as removed", () => {
		expect(diffNodes(baseline(), [projectNode(), databaseNode("orders")])).toEqual([
			{ id: "cache-sessions", op: "removed", kind: "cache", name: "sessions" },
		]);
	});

	it("reports new and modified in board order, then removed", () => {
		const draft = [projectNode(), databaseNode("invoices"), databaseNode("orders", 6543)];
		expect(diffNodes(baseline(), draft)).toEqual([
			{ id: "database-invoices", op: "new", kind: "database", name: "invoices" },
			{ id: "database-orders", op: "modified", kind: "database", name: "orders" },
			{ id: "cache-sessions", op: "removed", kind: "cache", name: "sessions" },
		]);
	});

	it("does not count a move alone as a change", () => {
		const draft = baseline().map((n) => ({
			...n,
			position: { x: n.position.x + 300, y: n.position.y + 120 },
		}));
		expect(diffNodes(baseline(), draft)).toEqual([]);
	});

	it("does not count selection or measured size as a change", () => {
		const draft = baseline().map((n) => ({
			...n,
			selected: true,
			measured: { width: 240, height: 130 },
		}));
		expect(diffNodes(baseline(), draft)).toEqual([]);
	});

	it("counts a change of cloud identity as modified", () => {
		const draft = baseline().map((n) =>
			n.id === "database-orders"
				? { ...n, data: { ...n.data, cloud_identity_id: "identity-2" } }
				: n,
		);
		expect(diffNodes(baseline(), draft)).toEqual([
			{ id: "database-orders", op: "modified", kind: "database", name: "orders" },
		]);
	});

	it("never reports the project root, whatever happened to it", () => {
		const renamed = baseline().map((n) =>
			n.data.kind === "project"
				? { ...n, data: { ...n.data, config: { ...n.data.config, region: "us-east-1" } } }
				: n,
		);
		expect(diffNodes(baseline(), renamed)).toEqual([]);

		const withoutRoot = baseline().filter((n) => n.data.kind !== "project");
		// Missing from the draft, and missing from the baseline.
		expect(diffNodes(baseline(), withoutRoot)).toEqual([]);
		expect(diffNodes(withoutRoot, baseline())).toEqual([]);
	});

	it("never reports an out-of-band kind as new", () => {
		const draft = [
			...baseline(),
			chartNode("shop"),
			chartWorkloadNode("w1", "shop", []),
			addonNode("grafana"),
			externalNode("database|module.data"),
		];
		expect(diffNodes(baseline(), draft)).toEqual([]);
	});

	it("never reports an out-of-band kind as removed", () => {
		const saved = [
			...baseline(),
			chartNode("shop"),
			chartWorkloadNode("w1", "shop", []),
			addonNode("grafana"),
			externalNode("database|module.data"),
		];
		expect(diffNodes(saved, baseline())).toEqual([]);
	});

	it("never reports an out-of-band kind as modified", () => {
		const saved = [...baseline(), addonNode("grafana", "8.1.2")];
		const draft = [...baseline(), addonNode("grafana", "8.2.0")];
		expect(diffNodes(saved, draft)).toEqual([]);
	});
});
