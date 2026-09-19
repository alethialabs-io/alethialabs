// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// "They don't hold their state." The workbench used to re-run `setGraph` whenever a server render
// handed it a new object of the SAME design — resetting the graph, closing the open card and
// discarding every unsaved edit. `reseed` compares the server revision it was seeded from and
// answers the four cases the effect actually meets. These pin each one.

import { beforeEach, describe, expect, it } from "vitest";
import {
	diffNodes,
	PROJECT_NODE_ID,
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
	useCanvasStore
		.getState()
		.reseed({ nodes: [projectNode(), dbNode("orders")] }, { scope: SCOPE, revision });
}

beforeEach(() => {
	useCanvasStore.getState().reset();
});

describe("reseed", () => {
	it("a first seed loads the graph and records the seed", () => {
		seedFromServer();
		const s = useCanvasStore.getState();
		expect(s.nodes.map((n) => n.id)).toEqual([PROJECT_NODE_ID, "database-orders"]);
		expect(s.seed).toEqual({ scope: SCOPE, revision: "r1" });
		expect(s.dirty).toBe(false);
	});

	it("same scope + same revision is a no-op: edits, the open card and history all survive", () => {
		seedFromServer();
		useCanvasStore.getState().openInspector("database-orders");
		useCanvasStore.getState().commit();
		useCanvasStore.getState().updateNodeConfig("database-orders", { port: 6543 });
		const before = useCanvasStore.getState().nodes;

		// The server re-rendered the identical design as a NEW object (the common case).
		seedFromServer("r1");
		const s = useCanvasStore.getState();
		expect(s.nodes).toBe(before);
		expect(s.card).toEqual({ kind: "inspector", nodeId: "database-orders" });
		expect(s.past).toHaveLength(1);
		expect(s.dirty).toBe(true);
	});

	it("same scope, new revision, clean draft: graph + baseline move, the inspector stays on a surviving id", () => {
		seedFromServer();
		useCanvasStore.getState().openInspector("database-orders");
		useCanvasStore.getState().reseed(
			{ nodes: [projectNode(), dbNode("orders", { port: 5433 }), dbNode("audit")] },
			{ scope: SCOPE, revision: "r2" },
		);
		const s = useCanvasStore.getState();
		expect(s.nodes.map((n) => n.id)).toEqual([
			PROJECT_NODE_ID,
			"database-orders",
			"database-audit",
		]);
		expect(s.card).toEqual({ kind: "inspector", nodeId: "database-orders" });
		expect(s.seed?.revision).toBe("r2");
		expect(diffNodes(s.baseline, s.nodes)).toEqual([]);
		expect(s.dirty).toBe(false);
	});

	it("same scope, new revision, clean draft: an inspector on a node the server removed closes", () => {
		seedFromServer();
		useCanvasStore.getState().openInspector("database-orders");
		useCanvasStore
			.getState()
			.reseed({ nodes: [projectNode()] }, { scope: SCOPE, revision: "r2" });
		expect(useCanvasStore.getState().card).toBeNull();
	});

	it("same scope, new revision, DIRTY draft: only the baseline moves and the diff is against the new truth", () => {
		seedFromServer();
		useCanvasStore.getState().updateNodeConfig("database-orders", { port: 6543 });
		const draft = useCanvasStore.getState().nodes;

		useCanvasStore.getState().reseed(
			{ nodes: [projectNode(), dbNode("orders"), dbNode("audit")] },
			{ scope: SCOPE, revision: "r2" },
		);
		const s = useCanvasStore.getState();
		expect(s.nodes).toBe(draft);
		expect(s.dirty).toBe(true);
		expect(s.seed?.revision).toBe("r2");
		// The user's draft, diffed against the server's new design: their port change is a
		// modification, and the table the server added (which their draft lacks) reads as removed.
		expect(diffNodes(s.baseline, s.nodes).map((c) => `${c.op}:${c.id}`).sort()).toEqual(
			["modified:database-orders", "removed:database-audit"].sort(),
		);
	});

	it("a different scope is a full load", () => {
		seedFromServer();
		useCanvasStore.getState().openInspector("database-orders");
		useCanvasStore.getState().updateNodeConfig("database-orders", { port: 6543 });
		useCanvasStore
			.getState()
			.reseed({ nodes: [projectNode(), dbNode("other")] }, { scope: "proj-1:env-b", revision: "x1" });
		const s = useCanvasStore.getState();
		expect(s.nodes.map((n) => n.id)).toEqual([PROJECT_NODE_ID, "database-other"]);
		expect(s.card).toBeNull();
		expect(s.dirty).toBe(false);
		expect(s.seed).toEqual({ scope: "proj-1:env-b", revision: "x1" });
	});

	it("setSeedRevision records the revision a save just wrote", () => {
		seedFromServer();
		useCanvasStore.getState().setSeedRevision("r9");
		expect(useCanvasStore.getState().seed).toEqual({ scope: SCOPE, revision: "r9" });
		// …and the next re-render of that revision is a no-op.
		useCanvasStore.getState().updateNodeConfig("database-orders", { port: 1 });
		seedFromServer("r9");
		expect(useCanvasStore.getState().dirty).toBe(true);
	});
});
