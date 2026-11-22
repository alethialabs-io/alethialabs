// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The workspace rail shows ONE card, named by one view-store field. These pin the contract every rail
// consumer builds on: opening replaces, closing clears, the inspector shim maps onto it, and the
// node-set changes that used to unconditionally null `inspectorNodeId` (undo, redo, discard,
// remove) now keep a card whose subject is still on the board — and never touch a non-inspector
// card at all. Plus the delete rule that used to live in React Flow: `deletable: false` nodes are
// kept, and every removal commits an undo step.

import { beforeEach, describe, expect, it } from "vitest";
import { board } from "@/lib/canvas/store/board";
import { PROJECT_NODE_ID } from "@/lib/canvas/store/types";
import {
	boardCard,
	boardNodes,
	inspectorNodeId,
	isBoardDirty,
	seedBoard,
} from "@/tests/fixtures/canvas/board";
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

/** No cards beside the design. */
const NONE: CanvasNode[] = [];

function seed(nodes: CanvasNode[]) {
	seedBoard(nodes);
}

/** The view store's actions. */
const view = () => board.view.getState();

beforeEach(() => {
	board.reset();
});

describe("openCard / openInspector", () => {
	it("opening replaces whatever card is showing; opening nothing clears it", () => {
		view().openCard({ kind: "activity" });
		expect(boardCard()).toEqual({ kind: "activity" });
		view().openCard({ kind: "env-settings" });
		expect(boardCard()).toEqual({ kind: "env-settings" });
		view().openCard(null);
		expect(boardCard()).toBeNull();
	});

	it("openInspector maps onto the card union and the subject", () => {
		seed([projectNode(), dbNode("orders")]);
		view().openInspector("database-orders");
		expect(boardCard()).toEqual({
			kind: "inspector",
			nodeId: "database-orders",
		});
		expect(view().subject).toEqual({ kind: "node", id: "database-orders" });
		expect(inspectorNodeId()).toBe("database-orders");
		view().openCard({ kind: "activity" });
		expect(inspectorNodeId()).toBeNull();
		view().openInspector(null);
		expect(boardCard()).toBeNull();
		expect(view().subject).toBeNull();
	});

	it("openInspector keeps the card a detour came from; openCard does not", () => {
		seed([projectNode(), dbNode("orders")]);
		view().openCard({ kind: "env-settings" });
		view().openCard({ kind: "activity" }, { back: true });
		view().openInspector("database-orders");
		expect(view().cardBack).toEqual({ kind: "env-settings" });
		view().openCard({ kind: "activity" });
		expect(view().cardBack).toBeNull();
	});
});

describe("node-set changes keep the card when its subject survives", () => {
	it("undoing a drag keeps a non-inspector card open", () => {
		seed([projectNode(), dbNode("orders")]);
		view().openCard({ kind: "activity" });
		board.document.getState().checkpoint("commit");
		board.onNodesChange(
			[{ id: "database-orders", type: "position", position: { x: 5, y: 5 } }],
			NONE,
		);
		board.undo(NONE);
		expect(boardCard()).toEqual({ kind: "activity" });
		board.redo(NONE);
		expect(boardCard()).toEqual({ kind: "activity" });
	});

	it("undo keeps an inspector whose node still exists, and closes one whose node is gone", () => {
		seed([projectNode(), dbNode("orders")]);
		// Adding a node commits a snapshot WITHOUT the new node; undo removes it.
		const added = board.addNode("cache");
		expect(boardCard()).toEqual({ kind: "inspector", nodeId: added });
		board.undo(NONE);
		expect(boardCard()).toBeNull();

		view().openInspector("database-orders");
		board.redo(NONE);
		expect(boardCard()).toEqual({
			kind: "inspector",
			nodeId: "database-orders",
		});
	});

	it("a collection card survives while any member of its kind remains", () => {
		seed([projectNode(), secretNode("a"), secretNode("b")]);
		view().openInspector("collection:secret");
		board.removeNodes(["secret-a"], NONE);
		expect(boardCard()).toEqual({
			kind: "inspector",
			nodeId: "collection:secret",
		});
		board.removeNodes(["secret-b"], NONE);
		expect(boardCard()).toBeNull();
	});

	it("discardChanges keeps the inspector on a baseline node and drops one on a new node", () => {
		seed([projectNode(), dbNode("orders")]);
		const added = board.addNode("cache");
		board.discard(NONE);
		expect(boardNodes().some((n) => n.id === added)).toBe(false);
		expect(boardCard()).toBeNull();

		view().openInspector("database-orders");
		board.discard(NONE);
		expect(boardCard()).toEqual({
			kind: "inspector",
			nodeId: "database-orders",
		});
	});
});

describe("removeNodes", () => {
	it("removes a deletable node, closes its inspector and commits an undo step", () => {
		seed([projectNode(), dbNode("orders")]);
		view().openInspector("database-orders");
		board.removeNodes(["database-orders"], NONE);
		expect(boardNodes().map((n) => n.id)).toEqual([PROJECT_NODE_ID]);
		expect(boardCard()).toBeNull();
		expect(board.document.getState().history.past).toHaveLength(1);
		expect(isBoardDirty()).toBe(true);
		board.undo(NONE);
		expect(boardNodes().map((n) => n.id)).toContain("database-orders");
	});

	it("keeps `deletable: false` nodes and the project root, and commits nothing for them", () => {
		seed([projectNode(), dbNode("chart-like", { deletable: false })]);
		board.removeNodes([PROJECT_NODE_ID, "database-chart-like"], NONE);
		expect(boardNodes()).toHaveLength(2);
		expect(board.document.getState().history.past).toHaveLength(0);
		expect(isBoardDirty()).toBe(false);
	});

	it("a mixed selection removes only the deletable members", () => {
		seed([projectNode(), dbNode("orders"), dbNode("pinned", { deletable: false })]);
		board.removeNodes(["database-orders", "database-pinned"], NONE);
		expect(boardNodes().map((n) => n.id).sort()).toEqual(
			["database-pinned", PROJECT_NODE_ID].sort(),
		);
	});
});
