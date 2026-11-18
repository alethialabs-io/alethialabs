// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// One board: a document store and a view store, the commands that touch both, and the draft slot
// (#6764). Each test creates its own board.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CanvasNode } from "@/components/design-project/canvas/graph/types";
import { createBoard, createNodeJoiner, flagsOf, type Board } from "@/lib/canvas/store/board";
import { draftStorageKey, parseDraft } from "@/lib/canvas/store/draft-persist";
import { addonNode, databaseNode, projectNode } from "@/tests/fixtures/canvas/nodes";

const SCOPE = "proj-1:env-a";
const KEY = draftStorageKey(SCOPE);
const DATABASE = "database-orders";
const NO_OTHERS: CanvasNode[] = [];

/** A board on its own draft slot, seeded with the project root and one database. */
function seeded(): Board {
	const board = createBoard();
	board.openDraftScope(SCOPE);
	board.reseed({ nodes: [projectNode(), databaseNode("orders")] }, { scope: SCOPE, revision: "r1" });
	return board;
}

/** The draft in the scope's slot. Throws when the slot is empty or unreadable. */
function slot() {
	const raw = sessionStorage.getItem(KEY);
	const draft = raw === null ? null : parseDraft(raw);
	if (!draft) throw new Error(`no readable draft under ${KEY}`);
	return draft;
}

beforeEach(() => {
	sessionStorage.clear();
});

describe("the board's nodes", () => {
	it("are the design nodes at their positions, then the cards beside them", () => {
		const board = seeded();
		const others = [addonNode("grafana")];
		const nodes = board.nodes(others);
		expect(nodes.map((n) => n.id)).toEqual(["project-root", DATABASE, "addon-grafana"]);
		expect(nodes[1].position).toEqual(board.document.getState().positions[DATABASE]);
		expect(nodes[2].position).toEqual({ x: 120, y: 520 });
	});

	it("are the same array until something they are made of changes", () => {
		const board = seeded();
		const first = board.nodes(NO_OTHERS);
		board.view.getState().openCard({ kind: "activity" });
		board.document.getState().checkpoint("commit");
		expect(board.nodes(NO_OTHERS)).toBe(first);
	});

	it("a move re-creates the moved card and no other", () => {
		const board = seeded();
		const [root, database] = board.nodes(NO_OTHERS);
		board.onNodesChange(
			[{ id: DATABASE, type: "position", position: { x: 5, y: 5 }, dragging: false }],
			NO_OTHERS,
		);
		const after = board.nodes(NO_OTHERS);
		expect(after[0]).toBe(root);
		expect(after[1]).not.toBe(database);
		expect(after[1].position).toEqual({ x: 5, y: 5 });
	});

	it("a card beside the design sits where a person dragged it", () => {
		const board = seeded();
		const others = [addonNode("grafana")];
		board.onNodesChange(
			[{ id: "addon-grafana", type: "position", position: { x: 77, y: 88 }, dragging: false }],
			others,
		);
		// The server sends the add-on again: new objects, the same card.
		expect(board.nodes([addonNode("grafana")])[2].position).toEqual({ x: 77, y: 88 });
	});
});

describe("React Flow's changes", () => {
	it("a drag never replaces the design and writes the draft once, when it ends", () => {
		const board = seeded();
		const design = board.document.getState().designNodes;
		const write = vi.spyOn(Storage.prototype, "setItem");

		for (let frame = 1; frame <= 30; frame++) {
			board.onNodesChange(
				[{ id: DATABASE, type: "position", position: { x: frame, y: frame }, dragging: true }],
				NO_OTHERS,
			);
		}
		expect(write).not.toHaveBeenCalled();
		expect(board.document.getState().designNodes).toBe(design);

		board.onNodesChange(
			[{ id: DATABASE, type: "position", position: { x: 31, y: 31 }, dragging: false }],
			NO_OTHERS,
		);
		expect(write).toHaveBeenCalledTimes(1);
		expect(slot().positions[DATABASE]).toEqual({ x: 31, y: 31 });
		expect(board.document.getState().history.past).toHaveLength(1);
		write.mockRestore();
	});

	it("selection is view state: it is on the nodes, and not in the document or the draft", () => {
		const board = seeded();
		const design = board.document.getState().designNodes;
		board.onNodesChange([{ id: DATABASE, type: "select", selected: true }], NO_OTHERS);

		expect(board.view.getState().selection).toEqual([DATABASE]);
		expect(board.nodes(NO_OTHERS)[1].selected).toBe(true);
		expect(board.document.getState().designNodes).toBe(design);
		expect(JSON.stringify(slot())).not.toContain("selected");
	});

	it("a structural change replaces the design nodes and hands back the cards beside them", () => {
		const board = seeded();
		const others = [addonNode("grafana")];
		const next = board.onNodesChange([{ id: DATABASE, type: "remove" }], others);
		expect(board.document.getState().designNodes.map((n) => n.id)).toEqual(["project-root"]);
		expect(next.map((n) => n.id)).toEqual(["addon-grafana"]);
	});

	it("flagsOf leaves the design and the position behind", () => {
		const node: CanvasNode = { ...databaseNode("orders"), selected: true, dragging: false };
		expect(flagsOf(node)).toEqual({ selected: true, dragging: false });
	});
});

describe("commands that change the node set", () => {
	it("adding a node selects it and opens the inspector on it", () => {
		const board = seeded();
		const id = board.addNode("bucket");
		expect(board.view.getState().selection).toEqual([id]);
		expect(board.view.getState().subject).toEqual({ kind: "node", id });
		expect(board.view.getState().card).toEqual({ kind: "inspector", nodeId: id });
	});

	it("undo closes an inspector whose node it removed, and keeps any other card", () => {
		const board = seeded();
		board.addNode("bucket");
		board.undo(NO_OTHERS);
		expect(board.view.getState().subject).toBeNull();

		board.view.getState().openCard({ kind: "activity" });
		board.addNodeWithConfig("queue", undefined, null, undefined, null);
		board.view.getState().openCard({ kind: "activity" });
		board.undo(NO_OTHERS);
		expect(board.view.getState().card).toEqual({ kind: "activity" });
		board.redo(NO_OTHERS);
		expect(board.view.getState().card).toEqual({ kind: "activity" });
	});

	it("undo leaves a card the design does not own on the board, with its inspector open", () => {
		const board = seeded();
		const others = [addonNode("grafana")];
		board.addNode("bucket");
		board.view.getState().openCard({ kind: "inspector", nodeId: "addon-grafana" });
		board.undo(others);
		expect(board.nodes(others).map((n) => n.id)).toContain("addon-grafana");
		expect(board.view.getState().card).toEqual({ kind: "inspector", nodeId: "addon-grafana" });
	});

	it("remove and discard close the inspector of a node that is gone", () => {
		const board = seeded();
		board.view.getState().openCard({ kind: "inspector", nodeId: DATABASE });
		board.removeNodes([DATABASE], NO_OTHERS);
		expect(board.view.getState().card).toBeNull();

		const added = board.addNode("bucket");
		board.discard(NO_OTHERS);
		expect(board.nodes(NO_OTHERS).map((n) => n.id)).not.toContain(added);
		expect(board.view.getState().card).toBeNull();
	});

	it("a moved server design keeps the inspector on a node that survived", () => {
		const board = seeded();
		board.view.getState().openCard({ kind: "inspector", nodeId: DATABASE });
		board.reseed(
			{ nodes: [projectNode(), databaseNode("orders", 5433)] },
			{ scope: SCOPE, revision: "r2" },
		);
		expect(board.view.getState().card).toEqual({ kind: "inspector", nodeId: DATABASE });

		board.load({ nodes: [projectNode()] });
		expect(board.view.getState().card).toBeNull();
	});
});

describe("the draft slot", () => {
	it("is written when the design changes, and read back by a new board on the same scope", () => {
		const first = seeded();
		first.document.getState().updateNodeConfig(DATABASE, { port: 6543 });

		const second = createBoard();
		expect(second.openDraftScope(SCOPE)).toBe(true);
		const node = second.document.getState().designNodes.find((n) => n.id === DATABASE);
		expect(node?.data.kind === "database" ? node.data.config.port : null).toBe(6543);
		// The history belongs to the editing session, not to the draft.
		expect(second.document.getState().history.past).toEqual([]);
	});

	it("an empty slot, an unreadable slot and another scope's draft all reset the board", () => {
		const board = createBoard();
		expect(board.openDraftScope(SCOPE)).toBe(false);

		sessionStorage.setItem(KEY, "{not json");
		expect(board.openDraftScope(SCOPE)).toBe(false);

		const other = draftStorageKey("proj-1:env-b");
		seeded();
		sessionStorage.setItem(other, sessionStorage.getItem(KEY) ?? "");
		expect(board.openDraftScope("proj-1:env-b")).toBe(false);
		expect(board.document.getState().designNodes.map((n) => n.id)).toEqual(["project-root"]);
	});

	it("setDraftKey redirects the writes; flushDraft writes now", () => {
		const board = seeded();
		const before = sessionStorage.getItem(KEY);
		board.setDraftKey("elsewhere");
		board.reset();
		expect(sessionStorage.getItem(KEY)).toBe(before);
		expect(sessionStorage.getItem("elsewhere")).not.toBeNull();

		sessionStorage.removeItem("elsewhere");
		board.flushDraft();
		expect(sessionStorage.getItem("elsewhere")).not.toBeNull();
	});
});

describe("createNodeJoiner", () => {
	it("returns the same node object while that node's own inputs are unchanged", () => {
		const joiner = createNodeJoiner();
		const design = [projectNode(), databaseNode("orders")];
		const positions = { "database-orders": { x: 1, y: 1 } };
		const first = joiner.join(design, NO_OTHERS, positions, {});
		const second = joiner.join(design, NO_OTHERS, { ...positions, "project-root": { x: 9, y: 9 } }, {});
		expect(second).not.toBe(first);
		expect(second[1]).toBe(first[1]);
		expect(second[0]).not.toBe(first[0]);
	});
});
