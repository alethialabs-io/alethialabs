// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// One tab, two environments, two drafts. The persisted draft used to live under ONE sessionStorage
// key regardless of project or environment, so switching the topbar env showed the previous env's
// unsaved design as if it were this one's. `openDraftScope` gives each project:environment its own
// slot and refuses to show a slot seeded for another scope.

import { beforeEach, describe, expect, it } from "vitest";
import { board } from "@/lib/canvas/store/board";
import { draftStorageKey } from "@/lib/canvas/store/draft-persist";
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

function dbNode(name: string): CanvasNode {
	return {
		id: `database-${name}`,
		type: "database",
		position: { x: 0, y: 0 },
		data: { kind: "database", config: { name }, cloud_identity_id: null, provider: "aws" },
	} as unknown as CanvasNode;
}

const A = "proj-1:env-a";
const B = "proj-1:env-b";

beforeEach(() => {
	sessionStorage.clear();
	board.reset();
});

describe("openDraftScope", () => {
	it("an empty slot resets the store and reports nothing restored", () => {
		board.reseed({ nodes: [projectNode(), dbNode("x")] }, { scope: "old", revision: "1" });
		expect(board.openDraftScope(A)).toBe(false);
		expect(boardNodes().map((n) => n.id)).toEqual([PROJECT_NODE_ID]);
		expect(board.document.getState().seed).toBeNull();
	});

	it("each scope keeps its own draft, and switching back restores the edit", () => {
		board.openDraftScope(A);
		board.reseed({ nodes: [projectNode(), dbNode("a")] }, { scope: A, revision: "1" });
		board.document.getState().updateNodeConfig("database-a", { port: 6543 });

		board.openDraftScope(B);
		board.reseed({ nodes: [projectNode(), dbNode("b")] }, { scope: B, revision: "1" });
		expect(boardNodes().some((n) => n.id === "database-a")).toBe(false);

		expect(sessionStorage.getItem(draftStorageKey(A))).not.toBeNull();
		expect(sessionStorage.getItem(draftStorageKey(B))).not.toBeNull();

		expect(board.openDraftScope(A)).toBe(true);
		expect(boardNodes().map((n) => n.id)).toEqual([PROJECT_NODE_ID, "database-a"]);
		// The restored draft is still UNSAVED. `reseed` asks this before letting a moved server
		// design replace the graph, so a draft that came back reading clean would be overwritten.
		expect(isBoardDirty()).toBe(true);
		const db = boardNodes().find((n) => n.id === "database-a");
		expect(db && "port" in db.data.config ? db.data.config.port : null).toBe(6543);
		expect(board.document.getState().seed).toEqual({ scope: A, revision: "1" });
	});

	it("the undo history does not travel between scopes", () => {
		board.openDraftScope(A);
		board.reseed({ nodes: [projectNode(), dbNode("a")] }, { scope: A, revision: "1" });
		// An edit in A, so A has an undoable step and an open card.
		board.view.getState().openInspector("database-a");
		board.document.getState().checkpoint("commit");
		board.document.getState().updateNodeConfig("database-a", { port: 6543 });
		expect(board.document.getState().history.past).toHaveLength(1);

		board.openDraftScope(B);
		board.reseed({ nodes: [projectNode(), dbNode("b")] }, { scope: B, revision: "1" });
		// Back to A: the persisted draft returns, but a hydrate restores only the persisted keys,
		// so without an explicit clear the stacks and the open card would be B's. An undo here used
		// to replay the OTHER environment's node set into this one.
		expect(board.openDraftScope(A)).toBe(true);
		expect(board.document.getState().history.past).toEqual([]);
		expect(board.document.getState().history.future).toEqual([]);
		expect(boardCard()).toBeNull();
		expect(board.view.getState().selection).toEqual([]);
		expect(boardNodes().map((n) => n.id)).toEqual([PROJECT_NODE_ID, "database-a"]);
	});

	it("a slot holding another scope's draft is discarded, never shown", () => {
		board.openDraftScope(A);
		board.reseed({ nodes: [projectNode(), dbNode("a")] }, { scope: A, revision: "1" });
		// Corrupt: copy A's blob under B's key (what a stale or hand-edited slot looks like).
		const blob = sessionStorage.getItem(draftStorageKey(A));
		expect(blob).not.toBeNull();
		sessionStorage.setItem(draftStorageKey(B), blob ?? "");

		expect(board.openDraftScope(B)).toBe(false);
		expect(boardNodes().map((n) => n.id)).toEqual([PROJECT_NODE_ID]);
	});
});
