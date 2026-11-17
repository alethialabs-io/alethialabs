// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The board's undo history, as a user meets it (#6762).
//
// Asserted through what undo and redo DO to the board, never through the stacks that hold the
// history, so the history can be rebuilt without rewriting this file.
//
// Three cases are `it.fails`: a field edit, a move and an out-of-band card are not handled by
// today's history, and each case states what a user is entitled to expect. `it.fails` goes green on
// ANY throw, including a broken setup, so every one of the three has a passing twin under "the
// steps the three cases below take" that asserts the setup alone.

import { beforeEach, describe, expect, it } from "vitest";
import { useCanvasStore } from "@/lib/stores/use-canvas-store";
import { databaseNode, projectNode } from "@/tests/fixtures/canvas/nodes";

const SCOPE = "proj-1:env-a";
const DATABASE = "database-orders";
const ADDON = "addon-grafana";

/** The live store. */
function board() {
	return useCanvasStore.getState();
}

/** Seed the board with a saved design: the project root and one database on port 5432. */
function seedBoard() {
	board().reseed(
		{ nodes: [projectNode(), databaseNode("orders")] },
		{ scope: SCOPE, revision: "rev-1" },
	);
}

/** Every node id on the board. */
function ids(): string[] {
	return board().nodes.map((n) => n.id);
}

/** How many nodes of `kind` are on the board. */
function countOf(kind: string): number {
	return board().nodes.filter((n) => n.data.kind === kind).length;
}

/** The seeded database's port, or null when the database is not on the board. */
function databasePort(): number | null {
	const node = board().nodes.find((n) => n.id === DATABASE);
	if (!node || node.data.kind !== "database") return null;
	return node.data.config.port ?? null;
}

/** Where the seeded database sits, or null when it is not on the board. */
function databasePosition(): { x: number; y: number } | null {
	const node = board().nodes.find((n) => n.id === DATABASE);
	return node ? { x: node.position.x, y: node.position.y } : null;
}

/** Edit one field of the seeded database, the way the inspector commits it. */
function editDatabasePort() {
	board().updateNodeConfig(DATABASE, { port: 6543 });
}

/** Drag the seeded database 200px right and 80px down, the way React Flow reports a finished drag. */
function dragDatabase(from: { x: number; y: number }) {
	board().onNodesChange([
		{
			id: DATABASE,
			type: "position",
			position: { x: from.x + 200, y: from.y + 80 },
			dragging: false,
		},
	]);
}

/** Add a card to the design, then let an installed add-on arrive from the server. */
function addSecretThenLoadAddon() {
	board().addNode("secret");
	board().setAddonNodes([
		{ id: "grafana", name: "Grafana", version: "8.1.2", namespace: "monitoring" },
	]);
}

beforeEach(() => {
	sessionStorage.clear();
	board().reset();
	seedBoard();
});

describe("undo and redo", () => {
	it("undoes an add and redoes it", () => {
		const added = board().addNode("bucket");
		expect(ids()).toContain(added);

		board().undo();
		expect(ids()).not.toContain(added);
		expect(ids()).toContain(DATABASE);

		board().redo();
		expect(ids()).toContain(added);
	});

	it("undoes a remove and redoes it", () => {
		board().removeNodes([DATABASE]);
		expect(ids()).not.toContain(DATABASE);

		board().undo();
		expect(ids()).toContain(DATABASE);

		board().redo();
		expect(ids()).not.toContain(DATABASE);
	});

	it("does nothing when there is nothing to undo or redo", () => {
		const before = ids();
		board().undo();
		expect(ids()).toEqual(before);
		board().redo();
		expect(ids()).toEqual(before);
	});

	it("walks back through several adds one at a time, newest first", () => {
		const first = board().addNode("bucket");
		const second = board().addNode("queue");

		board().undo();
		expect(ids()).toContain(first);
		expect(ids()).not.toContain(second);

		board().undo();
		expect(ids()).not.toContain(first);
	});

	it("keeps the last 50 steps and no more", () => {
		for (let i = 0; i < 60; i++) board().addNode("secret");
		expect(countOf("secret")).toBe(60);

		// Sixty undos: fifty take effect, and the ten oldest adds are beyond the history.
		for (let i = 0; i < 60; i++) board().undo();
		expect(countOf("secret")).toBe(10);
	});

	it("drops the redo once a new action is taken", () => {
		const undone = board().addNode("bucket");
		board().undo();
		expect(ids()).not.toContain(undone);

		const next = board().addNode("queue");
		const before = ids();
		board().redo();

		expect(ids()).toEqual(before);
		expect(ids()).toContain(next);
		expect(ids()).not.toContain(undone);
	});
});

describe("the steps the three cases below take", () => {
	it("a field edit lands on the node", () => {
		expect(databasePort()).toBe(5432);
		editDatabasePort();
		expect(databasePort()).toBe(6543);
	});

	it("a finished drag moves the node", () => {
		const start = databasePosition();
		if (!start) throw new Error("the seeded database is not on the board");
		dragDatabase(start);
		expect(databasePosition()).toEqual({ x: start.x + 200, y: start.y + 80 });
	});

	it("an add-on from the server sits on the board beside a card just added", () => {
		addSecretThenLoadAddon();
		expect(ids()).toContain(ADDON);
		expect(countOf("secret")).toBe(1);
	});
});

describe("what undo does not do yet", () => {
	it.fails("undoes a field edit", () => {
		editDatabasePort();
		board().undo();
		expect(databasePort()).toBe(5432);
	});

	it.fails("undoes a drag", () => {
		const start = databasePosition();
		if (!start) throw new Error("the seeded database is not on the board");
		dragDatabase(start);
		board().undo();
		expect(databasePosition()).toEqual(start);
	});

	it.fails("leaves an out-of-band card on the board", () => {
		addSecretThenLoadAddon();
		board().undo();
		expect(ids()).toContain(ADDON);
	});
});
