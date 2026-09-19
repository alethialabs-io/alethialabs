// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The workspace rail shows ONE card, named by one store field. These pin the contract every rail
// consumer builds on: opening replaces, closing clears, the inspector shim maps onto it, and the
// node-set changes that used to unconditionally null `inspectorNodeId` (undo, redo, discard,
// remove) now keep a card whose subject is still on the board — and never touch a non-inspector
// card at all. Plus the delete rule that used to live in React Flow: `deletable: false` nodes are
// kept, and every removal commits an undo step.

import { beforeEach, describe, expect, it } from "vitest";
import {
	PROJECT_NODE_ID,
	selectInspectorNodeId,
	useCanvasStore,
} from "@/lib/stores/use-canvas-store";
import type { CanvasNode } from "@/components/design-project/canvas/graph/types";

function projectNode(): CanvasNode {
	return {
		id: PROJECT_NODE_ID,
		type: "project",
		position: { x: 0, y: 0 },
		deletable: false,
		data: { kind: "project", config: { project_name: "p" }, cloud_identity_id: null, provider: "aws" },
	} as unknown as CanvasNode;
}

function dbNode(name: string, extra: Partial<CanvasNode> = {}): CanvasNode {
	return {
		id: `database-${name}`,
		type: "database",
		position: { x: 100, y: 100 },
		data: { kind: "database", config: { name }, cloud_identity_id: null, provider: "aws" },
		...extra,
	} as unknown as CanvasNode;
}

function secretNode(name: string): CanvasNode {
	return {
		id: `secret-${name}`,
		type: "secret",
		position: { x: 300, y: 100 },
		data: { kind: "secret", config: { name }, cloud_identity_id: null, provider: "aws" },
	} as unknown as CanvasNode;
}

function seed(nodes: CanvasNode[]) {
	useCanvasStore.setState({
		nodes,
		baseline: structuredClone(nodes),
		past: [],
		future: [],
		dirty: false,
		card: null,
		selectedIds: [],
	});
}

beforeEach(() => {
	useCanvasStore.getState().reset();
});

describe("openCard / closeCard / openInspector", () => {
	it("opening replaces whatever card is showing; closing clears it", () => {
		const s = useCanvasStore.getState();
		s.openCard({ kind: "activity" });
		expect(useCanvasStore.getState().card).toEqual({ kind: "activity" });
		s.openCard({ kind: "env-settings" });
		expect(useCanvasStore.getState().card).toEqual({ kind: "env-settings" });
		s.closeCard();
		expect(useCanvasStore.getState().card).toBeNull();
	});

	it("the openInspector shim maps onto the card union and the selector reads it back", () => {
		seed([projectNode(), dbNode("orders")]);
		useCanvasStore.getState().openInspector("database-orders");
		expect(useCanvasStore.getState().card).toEqual({
			kind: "inspector",
			nodeId: "database-orders",
		});
		expect(selectInspectorNodeId(useCanvasStore.getState())).toBe("database-orders");
		useCanvasStore.getState().openCard({ kind: "activity" });
		expect(selectInspectorNodeId(useCanvasStore.getState())).toBeNull();
		useCanvasStore.getState().openInspector(null);
		expect(useCanvasStore.getState().card).toBeNull();
	});
});

describe("node-set changes keep the card when its subject survives", () => {
	it("undoing a drag keeps a non-inspector card open", () => {
		seed([projectNode(), dbNode("orders")]);
		useCanvasStore.getState().openCard({ kind: "activity" });
		useCanvasStore.getState().commit();
		useCanvasStore.getState().onNodesChange([
			{ id: "database-orders", type: "position", position: { x: 5, y: 5 } },
		]);
		useCanvasStore.getState().undo();
		expect(useCanvasStore.getState().card).toEqual({ kind: "activity" });
		useCanvasStore.getState().redo();
		expect(useCanvasStore.getState().card).toEqual({ kind: "activity" });
	});

	it("undo keeps an inspector whose node still exists, and closes one whose node is gone", () => {
		seed([projectNode(), dbNode("orders")]);
		// Adding a node commits a snapshot WITHOUT the new node; undo removes it.
		const added = useCanvasStore.getState().addNode("cache");
		expect(useCanvasStore.getState().card).toEqual({ kind: "inspector", nodeId: added });
		useCanvasStore.getState().undo();
		expect(useCanvasStore.getState().card).toBeNull();

		useCanvasStore.getState().openInspector("database-orders");
		useCanvasStore.getState().redo();
		expect(useCanvasStore.getState().card).toEqual({
			kind: "inspector",
			nodeId: "database-orders",
		});
	});

	it("a collection card survives while any member of its kind remains", () => {
		seed([projectNode(), secretNode("a"), secretNode("b")]);
		useCanvasStore.getState().openInspector("collection:secret");
		useCanvasStore.getState().removeNodes(["secret-a"]);
		expect(useCanvasStore.getState().card).toEqual({
			kind: "inspector",
			nodeId: "collection:secret",
		});
		useCanvasStore.getState().removeNodes(["secret-b"]);
		expect(useCanvasStore.getState().card).toBeNull();
	});

	it("discardChanges keeps the inspector on a baseline node and drops one on a new node", () => {
		seed([projectNode(), dbNode("orders")]);
		const added = useCanvasStore.getState().addNode("cache");
		useCanvasStore.getState().discardChanges();
		expect(useCanvasStore.getState().nodes.some((n) => n.id === added)).toBe(false);
		expect(useCanvasStore.getState().card).toBeNull();

		useCanvasStore.getState().openInspector("database-orders");
		useCanvasStore.getState().discardChanges();
		expect(useCanvasStore.getState().card).toEqual({
			kind: "inspector",
			nodeId: "database-orders",
		});
	});
});

describe("removeNodes", () => {
	it("removes a deletable node, closes its inspector and commits an undo step", () => {
		seed([projectNode(), dbNode("orders")]);
		useCanvasStore.getState().openInspector("database-orders");
		useCanvasStore.getState().removeNodes(["database-orders"]);
		const s = useCanvasStore.getState();
		expect(s.nodes.map((n) => n.id)).toEqual([PROJECT_NODE_ID]);
		expect(s.card).toBeNull();
		expect(s.past).toHaveLength(1);
		expect(s.dirty).toBe(true);
		s.undo();
		expect(useCanvasStore.getState().nodes.map((n) => n.id)).toContain("database-orders");
	});

	it("keeps `deletable: false` nodes and the project root, and commits nothing for them", () => {
		seed([projectNode(), dbNode("chart-like", { deletable: false })]);
		useCanvasStore.getState().removeNodes([PROJECT_NODE_ID, "database-chart-like"]);
		const s = useCanvasStore.getState();
		expect(s.nodes).toHaveLength(2);
		expect(s.past).toHaveLength(0);
		expect(s.dirty).toBe(false);
	});

	it("a mixed selection removes only the deletable members", () => {
		seed([projectNode(), dbNode("orders"), dbNode("pinned", { deletable: false })]);
		useCanvasStore.getState().removeNodes(["database-orders", "database-pinned"]);
		expect(useCanvasStore.getState().nodes.map((n) => n.id).sort()).toEqual(
			["database-pinned", PROJECT_NODE_ID].sort(),
		);
	});
});
