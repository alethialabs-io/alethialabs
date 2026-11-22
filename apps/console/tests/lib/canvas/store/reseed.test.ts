// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// "They don't hold their state." The workbench used to re-run `setGraph` whenever a server render
// handed it a new object of the SAME design — resetting the graph, closing the open card and
// discarding every unsaved edit. `reseed` compares the server revision it was seeded from and
// answers the four cases the effect actually meets. These pin each one.

import { beforeEach, describe, expect, it } from "vitest";
import { board } from "@/lib/canvas/store/board";
import { diffNodes } from "@/lib/canvas/store/derive";
import { PROJECT_NODE_ID } from "@/lib/canvas/store/types";
import { boardCard, boardNodes, isBoardDirty } from "@/tests/fixtures/canvas/board";
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

function dbNode(name: string, config: Record<string, unknown> = {}): CanvasNode {
	return {
		id: `database-${name}`,
		type: "database",
		position: { x: 0, y: 0 },
		data: {
			kind: "database",
			config: { name, ...config },
			cloud_identity_id: null,
			provider: "aws",
		},
	} as unknown as CanvasNode;
}

const SCOPE = "proj-1:env-a";

/** Seed from server revision r1 with one database. */
function seedFromServer(revision = "r1") {
	board.reseed({ nodes: [projectNode(), dbNode("orders")] }, { scope: SCOPE, revision });
}

/** The document as it stands. */
const doc = () => board.document.getState();

beforeEach(() => {
	board.reset();
});

describe("reseed", () => {
	it("a first seed loads the graph and records the seed", () => {
		seedFromServer();
		expect(boardNodes().map((n) => n.id)).toEqual([PROJECT_NODE_ID, "database-orders"]);
		expect(doc().seed).toEqual({ scope: SCOPE, revision: "r1" });
		expect(isBoardDirty()).toBe(false);
	});

	it("same scope + same revision is a no-op: edits, the open card and history all survive", () => {
		seedFromServer();
		board.view.getState().openInspector("database-orders");
		doc().checkpoint("commit");
		doc().updateNodeConfig("database-orders", { port: 6543 });
		const before = doc().designNodes;

		// The server re-rendered the identical design as a NEW object (the common case).
		seedFromServer("r1");
		expect(doc().designNodes).toBe(before);
		expect(boardCard()).toEqual({ kind: "inspector", nodeId: "database-orders" });
		expect(doc().history.past).toHaveLength(1);
		expect(isBoardDirty()).toBe(true);
	});

	it("same scope, new revision, clean draft: graph + baseline move, the inspector stays on a surviving id", () => {
		seedFromServer();
		board.view.getState().openInspector("database-orders");
		board.reseed(
			{ nodes: [projectNode(), dbNode("orders", { port: 5433 }), dbNode("audit")] },
			{ scope: SCOPE, revision: "r2" },
		);
		expect(boardNodes().map((n) => n.id)).toEqual([
			PROJECT_NODE_ID,
			"database-orders",
			"database-audit",
		]);
		expect(boardCard()).toEqual({ kind: "inspector", nodeId: "database-orders" });
		expect(doc().seed?.revision).toBe("r2");
		expect(diffNodes(doc().baseline, doc().designNodes)).toEqual([]);
		expect(isBoardDirty()).toBe(false);
	});

	it("same scope, new revision, clean draft: an inspector on a node the server removed closes", () => {
		seedFromServer();
		board.view.getState().openInspector("database-orders");
		board.reseed({ nodes: [projectNode()] }, { scope: SCOPE, revision: "r2" });
		expect(boardCard()).toBeNull();
	});

	it("same scope, new revision, DIRTY draft: only the baseline moves and the diff is against the new truth", () => {
		seedFromServer();
		doc().updateNodeConfig("database-orders", { port: 6543 });
		const draft = doc().designNodes;

		board.reseed(
			{ nodes: [projectNode(), dbNode("orders"), dbNode("audit")] },
			{ scope: SCOPE, revision: "r2" },
		);
		expect(doc().designNodes).toBe(draft);
		expect(isBoardDirty()).toBe(true);
		expect(doc().seed?.revision).toBe("r2");
		// The user's draft, diffed against the server's new design: their port change is a
		// modification, and the table the server added (which their draft lacks) reads as removed.
		expect(diffNodes(doc().baseline, doc().designNodes).map((c) => `${c.op}:${c.id}`).sort()).toEqual(
			["modified:database-orders", "removed:database-audit"].sort(),
		);
	});

	it("a different scope is a full load", () => {
		seedFromServer();
		board.view.getState().openInspector("database-orders");
		doc().updateNodeConfig("database-orders", { port: 6543 });
		board.reseed({ nodes: [projectNode(), dbNode("other")] }, { scope: "proj-1:env-b", revision: "x1" });
		expect(boardNodes().map((n) => n.id)).toEqual([PROJECT_NODE_ID, "database-other"]);
		expect(boardCard()).toBeNull();
		expect(isBoardDirty()).toBe(false);
		expect(doc().seed).toEqual({ scope: "proj-1:env-b", revision: "x1" });
	});

	it("setSeedRevision records the revision a save just wrote", () => {
		seedFromServer();
		doc().setSeedRevision("r9");
		expect(doc().seed).toEqual({ scope: SCOPE, revision: "r9" });
		// …and the next re-render of that revision is a no-op.
		doc().updateNodeConfig("database-orders", { port: 1 });
		seedFromServer("r9");
		expect(isBoardDirty()).toBe(true);
	});
});
