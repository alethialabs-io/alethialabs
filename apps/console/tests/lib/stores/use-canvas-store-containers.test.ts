// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Container geometry is a VIEW override, not a data change: dragging or resizing a region writes a
// session-only box (never the DB, never the Deploy diff) and dragging a region moves its members'
// ABSOLUTE positions — which the diff also ignores. These tests pin exactly that: the geometry
// actions do what they say, they never register a staged change, and every re-derive path clears the
// overrides so a region can't strand itself away from its members.

import { beforeEach, describe, expect, it } from "vitest";
import { diffNodes, PROJECT_NODE_ID, useCanvasStore } from "@/lib/stores/use-canvas-store";
import type { CanvasNode } from "@/components/design-project/canvas/graph/types";

const NETWORK = "zone:network";
const CLUSTER = "zone:cluster";

function projectNode(): CanvasNode {
	return {
		id: PROJECT_NODE_ID,
		type: "project",
		position: { x: 0, y: 0 },
		data: { kind: "project", config: { project_name: "p" }, cloud_identity_id: null, provider: "aws" },
	} as unknown as CanvasNode;
}

function dbNode(name: string, x: number, y: number): CanvasNode {
	return {
		id: `database-${name}`,
		type: "database",
		position: { x, y },
		data: { kind: "database", config: { name }, cloud_identity_id: null, provider: "aws" },
	} as unknown as CanvasNode;
}

/** A clean store: one project + one database, no overrides, no history. */
function seed(nodes: CanvasNode[]) {
	useCanvasStore.setState({
		nodes,
		baseline: structuredClone(nodes),
		containerGeometry: {},
		collectionPositions: {},
		past: [],
		future: [],
		dirty: false,
	});
}

beforeEach(() => {
	useCanvasStore.getState().reset();
});

describe("setContainerGeometry / resetContainerGeometry", () => {
	it("pins a box and then re-fits (drops it)", () => {
		const s = useCanvasStore.getState();
		s.setContainerGeometry(NETWORK, { x: 10, y: 20, width: 300, height: 200 });
		expect(useCanvasStore.getState().containerGeometry[NETWORK]).toEqual({
			x: 10,
			y: 20,
			width: 300,
			height: 200,
		});
		useCanvasStore.getState().resetContainerGeometry(NETWORK);
		expect(useCanvasStore.getState().containerGeometry[NETWORK]).toBeUndefined();
	});

	it("re-fitting a region that was never pinned is a harmless no-op", () => {
		useCanvasStore.getState().resetContainerGeometry(NETWORK);
		expect(useCanvasStore.getState().containerGeometry).toEqual({});
	});
});

describe("translateContainer", () => {
	it("shifts every member's absolute position by the delta, and shifts each pinned box", () => {
		seed([projectNode(), dbNode("orders", 100, 100)]);
		useCanvasStore.getState().translateContainer(
			{ x: 40, y: 25 },
			{
				memberIds: ["database-orders"],
				pins: [
					{ id: NETWORK, box: { x: 0, y: 0, width: 500, height: 400 } },
					{ id: CLUSTER, box: { x: 50, y: 50, width: 200, height: 200 } },
				],
			},
		);
		const state = useCanvasStore.getState();
		expect(state.nodes.find((n) => n.id === "database-orders")!.position).toEqual({
			x: 140,
			y: 125,
		});
		// The dragged region and the pinned nested cluster both ride along by the same delta.
		expect(state.containerGeometry[NETWORK]).toEqual({ x: 40, y: 25, width: 500, height: 400 });
		expect(state.containerGeometry[CLUSTER]).toEqual({ x: 90, y: 75, width: 200, height: 200 });
	});

	it("a zero delta (a click without a move) changes nothing", () => {
		seed([projectNode(), dbNode("orders", 100, 100)]);
		const before = useCanvasStore.getState().nodes;
		useCanvasStore.getState().translateContainer(
			{ x: 0, y: 0 },
			{ memberIds: ["database-orders"], pins: [] },
		);
		expect(useCanvasStore.getState().nodes).toBe(before);
	});

	it("does NOT push an undo snapshot (matches a card drag — history isn't per-frame)", () => {
		seed([projectNode(), dbNode("orders", 100, 100)]);
		useCanvasStore.getState().translateContainer(
			{ x: 40, y: 25 },
			{ memberIds: ["database-orders"], pins: [{ id: NETWORK, box: { x: 0, y: 0, width: 10, height: 10 } }] },
		);
		expect(useCanvasStore.getState().past).toHaveLength(0);
	});
});

describe("geometry never reaches the Deploy diff", () => {
	it("pinning + dragging a region produces NO staged change (the diff is position-agnostic)", () => {
		seed([projectNode(), dbNode("orders", 100, 100)]);
		useCanvasStore.getState().setContainerGeometry(NETWORK, { x: 0, y: 0, width: 400, height: 300 });
		useCanvasStore.getState().translateContainer(
			{ x: 60, y: 60 },
			{ memberIds: ["database-orders"], pins: [{ id: NETWORK, box: { x: 0, y: 0, width: 400, height: 300 } }] },
		);
		const { baseline, nodes } = useCanvasStore.getState();
		expect(diffNodes(baseline, nodes)).toEqual([]);
	});
});

describe("every re-derive path clears the overrides", () => {
	it("relayout re-fits all regions", () => {
		seed([projectNode(), dbNode("orders", 100, 100)]);
		useCanvasStore.getState().setContainerGeometry(NETWORK, { x: 0, y: 0, width: 400, height: 300 });
		useCanvasStore.getState().relayout();
		expect(useCanvasStore.getState().containerGeometry).toEqual({});
	});

	it("discardChanges reverts the view too", () => {
		seed([projectNode(), dbNode("orders", 100, 100)]);
		useCanvasStore.getState().setContainerGeometry(NETWORK, { x: 0, y: 0, width: 400, height: 300 });
		useCanvasStore.getState().discardChanges();
		expect(useCanvasStore.getState().containerGeometry).toEqual({});
	});

	it("reset clears them", () => {
		useCanvasStore.getState().setContainerGeometry(NETWORK, { x: 0, y: 0, width: 400, height: 300 });
		useCanvasStore.getState().reset();
		expect(useCanvasStore.getState().containerGeometry).toEqual({});
	});

	it("setGraph (a freshly loaded project) starts with no overrides", () => {
		useCanvasStore.getState().setContainerGeometry(NETWORK, { x: 0, y: 0, width: 400, height: 300 });
		useCanvasStore.getState().setGraph({ nodes: [dbNode("orders", 0, 0)] });
		expect(useCanvasStore.getState().containerGeometry).toEqual({});
	});
});
