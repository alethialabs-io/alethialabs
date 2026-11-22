// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The board's commands with the server data they need bound in, one board per scope, and the board
// on screen for code drawn outside it (#7129). What the legacy store's projection used to pin —
// cards the design does not own stay out of the document and the draft, and discard, undo and
// repair leave them where they are — is pinned here against the commands that replaced it.

import { beforeEach, describe, expect, it } from "vitest";
import type { CloudIdentityOption } from "@/app/server/actions/aws/identities";
import type { CanvasNode } from "@/components/design-project/canvas/graph/types";
import {
	activeBoardActions,
	activeCanvas,
	publishActiveCanvas,
} from "@/lib/canvas/store/active-canvas";
import { board as outside, boardFor, createBoard, type Board } from "@/lib/canvas/store/board";
import { boardActions } from "@/lib/canvas/store/board-actions";
import { draftStorageKey, parseDraft } from "@/lib/canvas/store/draft-persist";
import { addonNodes } from "@/lib/canvas/store/out-of-band";
import { PROJECT_NODE_ID } from "@/lib/canvas/store/types";
import { databaseNode, projectNode } from "@/tests/fixtures/canvas/nodes";

const SCOPE = "proj-1:env-a";
const DATABASE = "database-orders";
const GRAFANA = addonNodes([
	{ id: "grafana", name: "Grafana", version: "8.1.2", namespace: "monitoring" },
]);
const GCP: CloudIdentityOption = { id: "ident-gcp", name: "data", displayId: "2", provider: "gcp" };

/** A board on its own draft slot, seeded with the project root and one database. */
function seeded(): Board {
	const board = createBoard();
	board.openDraftScope(SCOPE);
	board.reseed({ nodes: [projectNode(), databaseNode("orders")] }, { scope: SCOPE, revision: "r1" });
	return board;
}

/** The ids of `nodes`, in order. */
function ids(nodes: CanvasNode[]): string[] {
	return nodes.map((n) => n.id);
}

beforeEach(() => {
	sessionStorage.clear();
});

describe("cards the design does not own", () => {
	it("are on the board beside the design and never in the document", () => {
		const board = seeded();
		const actions = boardActions(board, GRAFANA, []);
		expect(ids(actions.nodes())).toEqual([PROJECT_NODE_ID, DATABASE, "addon-grafana"]);
		expect(ids(board.document.getState().designNodes)).toEqual([PROJECT_NODE_ID, DATABASE]);
	});

	it("never reach the draft", () => {
		const board = seeded();
		const actions = boardActions(board, GRAFANA, []);
		actions.addNode("bucket");
		board.document.getState().updateNodeConfig(DATABASE, { port: 6543 });

		const raw = sessionStorage.getItem(draftStorageKey(SCOPE));
		expect(raw).not.toBeNull();
		expect(raw).not.toContain("grafana");
		expect(parseDraft(raw ?? "")?.designNodes.map((n) => n.id)).not.toContain("addon-grafana");
	});

	it("are left on the board by a discard and an undo", () => {
		const board = seeded();
		const actions = boardActions(board, GRAFANA, []);
		actions.addNode("bucket");
		actions.undo();
		expect(ids(actions.nodes())).toEqual([PROJECT_NODE_ID, DATABASE, "addon-grafana"]);
		actions.addNode("bucket");
		actions.discard();
		expect(ids(actions.nodes())).toEqual([PROJECT_NODE_ID, DATABASE, "addon-grafana"]);
	});

	it("cannot be removed through the design's remove", () => {
		const board = seeded();
		const actions = boardActions(board, GRAFANA, []);
		actions.removeNodes(["addon-grafana"]);
		expect(ids(actions.nodes())).toContain("addon-grafana");
		expect(board.document.getState().history.past).toHaveLength(0);
	});

	it("are moved off a design card they sit on by a repair", () => {
		const board = seeded();
		const actions = boardActions(board, GRAFANA, []);
		const database = actions.nodes().find((n) => n.id === DATABASE);
		if (!database) throw new Error("the seeded database is not on the board");
		actions.onNodesChange([
			{ id: "addon-grafana", type: "position", position: database.position, dragging: false },
		]);
		expect(actions.nodes().find((n) => n.id === "addon-grafana")?.position).toEqual(
			database.position,
		);
		actions.repairOverlaps();
		expect(actions.nodes().find((n) => n.id === "addon-grafana")?.position).not.toEqual(
			database.position,
		);
	});

	it("read as the project's cloud", () => {
		const board = seeded();
		board.document.getState().setNodeIdentity(PROJECT_NODE_ID, null, "azure");
		expect(boardActions(board, GRAFANA, []).effectiveProvider("addon-grafana")).toBe("azure");
	});
});

describe("adding on a cloud account", () => {
	it("stamps the account's cloud from the identity list on the new node", () => {
		const board = seeded();
		const actions = boardActions(board, [], [GCP]);
		const id = actions.addNodeWithConfig("database", { name: "audit" }, GCP.id);
		const added = board.document.getState().designNodes.find((n) => n.id === id);
		expect(added?.data.cloud_identity_id).toBe(GCP.id);
		expect(actions.effectiveProvider(id)).toBe("gcp");
	});

	it("an account the list does not name stamps no cloud of its own", () => {
		const board = seeded();
		const id = boardActions(board, [], []).addNodeWithConfig("database", { name: "x" }, "ident-gone");
		const added = board.document.getState().designNodes.find((n) => n.id === id);
		expect(added?.data.provider).toBeNull();
	});

	it("duplicates through the document, one step", () => {
		const board = seeded();
		boardActions(board, [], []).duplicateNodes([DATABASE]);
		const databases = board.document.getState().designNodes.filter((n) => n.data.kind === "database");
		expect(databases).toHaveLength(2);
		expect(board.document.getState().history.past).toHaveLength(1);
	});
});

describe("a board per scope", () => {
	it("is the same board every time a scope is opened, and another board for another scope", () => {
		const a = boardFor("proj-1:env-a");
		expect(boardFor("proj-1:env-a")).toBe(a);
		expect(boardFor("proj-1:env-b")).not.toBe(a);
		expect(a).not.toBe(outside);
	});

	it("an edit on one scope's board is not on another's", () => {
		const a = boardFor("proj-2:env-a");
		const b = boardFor("proj-2:env-b");
		a.reseed({ nodes: [projectNode(), databaseNode("orders")] }, { scope: "proj-2:env-a", revision: "1" });
		b.reseed({ nodes: [projectNode()] }, { scope: "proj-2:env-b", revision: "1" });
		a.document.getState().updateNodeConfig(DATABASE, { port: 6543 });
		expect(ids(b.document.getState().designNodes)).toEqual([PROJECT_NODE_ID]);
		expect(b.document.getState().seed?.scope).toBe("proj-2:env-b");
	});

	it("each board writes its draft to its own slot", () => {
		const a = boardFor("proj-3:env-a");
		a.openDraftScope("proj-3:env-a");
		a.reseed({ nodes: [projectNode()] }, { scope: "proj-3:env-a", revision: "1" });
		expect(sessionStorage.getItem(draftStorageKey("proj-3:env-a"))).not.toBeNull();
		expect(sessionStorage.getItem(draftStorageKey("proj-3:env-b"))).toBeNull();
	});
});

describe("the board on screen", () => {
	it("is the board outside any workbench until one is published", () => {
		expect(activeCanvas().board).toBe(outside);
		expect(activeCanvas().others).toEqual([]);
	});

	it("is the published board, with its identities and cards, until it is taken down", () => {
		const board = seeded();
		const takeDown = publishActiveCanvas({ board, identities: [GCP], others: GRAFANA });
		expect(activeCanvas().board).toBe(board);
		expect(ids(activeBoardActions().nodes())).toEqual([PROJECT_NODE_ID, DATABASE, "addon-grafana"]);
		takeDown();
		expect(activeCanvas().board).toBe(outside);
	});

	it("taking down a board that was already replaced leaves the replacement up", () => {
		const first = publishActiveCanvas({ board: seeded(), identities: [], others: [] });
		const second = seeded();
		const takeDownSecond = publishActiveCanvas({ board: second, identities: [], others: [] });
		first();
		expect(activeCanvas().board).toBe(second);
		takeDownSecond();
		expect(activeCanvas().board).toBe(outside);
	});
});
