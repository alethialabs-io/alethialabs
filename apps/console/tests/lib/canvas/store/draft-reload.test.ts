// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The draft a tab keeps across a reload (#6762): which sessionStorage slot it is written to, which
// keys it holds, and that a draft written in an earlier format comes back as the same board with
// the same pending changes.
//
// `tests/fixtures/canvas/draft-v1.json` is a version-1 draft typed by hand — a saved design with one
// field edited, one card added and one removed. It is not a capture of what the store wrote, so it
// stays a fixed point: whatever the persisted format becomes, a tab that still holds this blob has
// to open as this board.
//
// The format the store WRITES is version 2 since the store split (#6764): the design and the card
// positions are stored apart, and nothing derivable is stored — no `edges`, no `dirty`, and no
// `containerGeometry`, which nothing had read or written for some time.

import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { board as theBoard } from "@/lib/canvas/store/board";
import { diffNodes } from "@/lib/canvas/store/derive";
import { draftStorageKey } from "@/lib/canvas/store/draft-persist";
import { isBoardDirty } from "@/tests/fixtures/canvas/board";
import draftV1 from "@/tests/fixtures/canvas/draft-v1.json";
import { cacheNode, databaseNode, projectNode } from "@/tests/fixtures/canvas/nodes";

const SCOPE = "proj-1:env-a";
const STORAGE_KEY = "design-project-canvas-draft:proj-1:env-a";

/** The envelope the draft slot holds: the persisted state and the format version. */
const persistedDraft = z.object({
	state: z.record(z.string(), z.unknown()),
	version: z.number(),
});

/** The board as it stands, and the commands these cases take. */
function board() {
	const d = theBoard.document.getState();
	return {
		nodes: theBoard.nodes([]),
		baseline: d.baseline,
		seed: d.seed,
		collectionPositions: d.collectionPositions,
		dirty: isBoardDirty(),
		reset: () => theBoard.reset(),
		reseed: theBoard.reseed,
		addNode: theBoard.addNode,
		updateNodeConfig: d.updateNodeConfig,
		removeNodes: (ids: string[]) => theBoard.removeNodes(ids, []),
	};
}

/** Open the scope's draft slot, as the workbench does when the board for it mounts. */
function openScope(scope: string): boolean {
	return theBoard.openDraftScope(scope);
}

/** What is in the scope's storage slot right now, parsed. Throws when the slot is empty. */
function readSlot() {
	const raw = sessionStorage.getItem(STORAGE_KEY);
	if (raw === null) throw new Error(`nothing is stored under ${STORAGE_KEY}`);
	return persistedDraft.parse(JSON.parse(raw));
}

/**
 * What a page reload does to the tab: the in-memory store starts over, sessionStorage keeps what it
 * held. The slot is put back after the reset because the reset itself writes the draft.
 */
function reloadTab() {
	const kept = sessionStorage.getItem(STORAGE_KEY);
	board().reset();
	sessionStorage.clear();
	if (kept !== null) sessionStorage.setItem(STORAGE_KEY, kept);
}

/** The pending changes the hand-written draft holds against its own baseline. */
const DRAFT_V1_CHANGES = [
	{ id: "database-orders", op: "modified", kind: "database", name: "orders" },
	{ id: "bucket-1a2b3c4d", op: "new", kind: "bucket", name: "uploads" },
	{ id: "cache-sessions", op: "removed", kind: "cache", name: "sessions" },
];

beforeEach(() => {
	sessionStorage.clear();
	board().reset();
});

describe("where and what the draft persists", () => {
	it("writes the draft under one key per project and environment", () => {
		expect(draftStorageKey(SCOPE)).toBe(STORAGE_KEY);

		openScope(SCOPE);
		board().reseed(
			{ nodes: [projectNode(), databaseNode("orders")] },
			{ scope: SCOPE, revision: "rev-1" },
		);

		// The slot holds THIS seed, so it is the write the reseed made and not a leftover.
		expect(readSlot().state.seed).toEqual({ scope: SCOPE, revision: "rev-1" });
	});

	it("persists exactly these keys, at version 2", () => {
		openScope(SCOPE);
		board().reseed(
			{ nodes: [projectNode(), databaseNode("orders")] },
			{ scope: SCOPE, revision: "rev-1" },
		);
		// An open card, a selection and an undo step: none of them is part of the draft.
		board().addNode("bucket");

		const slot = readSlot();
		expect(slot.version).toBe(2);
		expect(Object.keys(slot.state).sort()).toEqual([
			"appliedSeedKeys",
			"arranged",
			"baseline",
			"collectionPositions",
			"designNodes",
			"operations",
			"positions",
			"seed",
		]);
		expect(slot.state.seed).toEqual({ scope: SCOPE, revision: "rev-1" });
		// Whether the draft is dirty is not stored: it is what differs from the baseline.
		expect(board().dirty).toBe(true);
	});

	it("the hand-written draft holds the keys version 1 wrote", () => {
		expect(Object.keys(draftV1.state).sort()).toEqual([
			"baseline",
			"collectionPositions",
			"containerGeometry",
			"dirty",
			"edges",
			"nodes",
			"seed",
		]);
		expect(draftV1.version).toBe(1);
	});
});

describe("a version-1 draft found in the tab", () => {
	beforeEach(() => {
		sessionStorage.setItem(STORAGE_KEY, JSON.stringify(draftV1));
	});

	it("rehydrates to the same nodes and baseline", () => {
		expect(openScope(SCOPE)).toBe(true);

		expect(board().nodes).toEqual(draftV1.state.nodes);
		expect(board().baseline).toEqual(draftV1.state.baseline);
		expect(board().seed).toEqual({ scope: SCOPE, revision: "rev-1" });
		expect(board().collectionPositions).toEqual({ secret: { x: 40, y: 80 } });
	});

	it("comes back with its pending changes, still unsaved", () => {
		openScope(SCOPE);

		expect(diffNodes(board().baseline, board().nodes)).toEqual(DRAFT_V1_CHANGES);
		expect(board().dirty).toBe(true);
	});

	it("is not replaced when the server hands back the design it was seeded from", () => {
		openScope(SCOPE);
		// The first render after a reload: the same scope, the same revision.
		board().reseed(
			{ nodes: [projectNode(), databaseNode("orders"), cacheNode("sessions")] },
			{ scope: SCOPE, revision: "rev-1" },
		);

		expect(board().nodes).toEqual(draftV1.state.nodes);
		expect(diffNodes(board().baseline, board().nodes)).toEqual(DRAFT_V1_CHANGES);
	});
});

describe("pending changes across a reload", () => {
	it("survive it: an edit, an add and a remove are all still pending", () => {
		openScope(SCOPE);
		board().reseed(
			{ nodes: [projectNode(), databaseNode("orders"), cacheNode("sessions")] },
			{ scope: SCOPE, revision: "rev-1" },
		);
		board().updateNodeConfig("database-orders", { port: 6543 });
		const added = board().addNode("bucket");
		board().removeNodes(["cache-sessions"]);

		const pending = diffNodes(board().baseline, board().nodes);
		expect(pending).toEqual([
			{ id: "database-orders", op: "modified", kind: "database", name: "orders" },
			{ id: added, op: "new", kind: "bucket", name: "assets" },
			{ id: "cache-sessions", op: "removed", kind: "cache", name: "sessions" },
		]);

		reloadTab();
		expect(board().nodes.map((n) => n.id)).toEqual(["project-root"]);

		expect(openScope(SCOPE)).toBe(true);
		expect(diffNodes(board().baseline, board().nodes)).toEqual(pending);
		expect(board().dirty).toBe(true);
	});

	it("a clean draft comes back clean", () => {
		openScope(SCOPE);
		board().reseed(
			{ nodes: [projectNode(), databaseNode("orders")] },
			{ scope: SCOPE, revision: "rev-1" },
		);

		reloadTab();

		expect(openScope(SCOPE)).toBe(true);
		expect(diffNodes(board().baseline, board().nodes)).toEqual([]);
		expect(board().dirty).toBe(false);
	});
});
