// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The document store (#6764): the design, where its cards sit, the saved design, and the undo
// history of all three. Each test builds its own store, so nothing here shares state with the
// board of the tab or with another test.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CanvasNode } from "@/components/design-project/canvas/graph/types";
import { deployGate, diffNodes, planReviewState } from "@/lib/canvas/store/derive";
import {
	createDocumentStore,
	draftOf,
	pendingCount,
	placeNodes,
	type DocumentStore,
} from "@/lib/canvas/store/document-store";
import { UNPLACED } from "@/lib/canvas/store/draft-persist";
import type { StagedOperation } from "@/lib/canvas/store/types";
import {
	addonNode,
	cacheNode,
	databaseNode,
	projectNode,
} from "@/tests/fixtures/canvas/nodes";

const SCOPE = "proj-1:env-a";
const DATABASE = "database-orders";

/** A store seeded with a saved design: the project root and one database on port 5432. */
function seeded(): DocumentStore {
	const store = createDocumentStore();
	store
		.getState()
		.reseed({ nodes: [projectNode(), databaseNode("orders")] }, { scope: SCOPE, revision: "r1" });
	return store;
}

/** The port the seeded database holds, or null when it is not in the design. */
function port(store: DocumentStore): number | null {
	const node = store.getState().designNodes.find((n) => n.id === DATABASE);
	if (!node || node.data.kind !== "database") return null;
	return node.data.config.port ?? null;
}

/** Every design node id. */
function ids(store: DocumentStore): string[] {
	return store.getState().designNodes.map((n) => n.id);
}

const GRAFANA: StagedOperation = {
	id: "addon:grafana",
	target: "addon",
	verb: "install",
	targetId: "grafana",
	summary: "install 8.1.2",
	input: { version: "8.1.2" },
};

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-11-17T10:00:00Z"));
});

afterEach(() => {
	vi.useRealTimers();
});

describe("what the document holds", () => {
	it("holds design nodes without a position, and the positions beside them", () => {
		const store = seeded();
		const s = store.getState();
		expect(s.designNodes.every((n) => n.position === UNPLACED)).toBe(true);
		expect(Object.keys(s.positions).sort()).toEqual([DATABASE, "project-root"].sort());
		expect(placeNodes(s.designNodes, s.positions)).toEqual(s.baseline);
	});

	it("never holds a card the design does not own", () => {
		const store = createDocumentStore();
		store.getState().load({ nodes: [projectNode(), databaseNode("orders"), addonNode("grafana")] });
		expect(ids(store)).toEqual(["project-root", DATABASE]);
		expect(store.getState().baseline.map((n) => n.id)).toEqual(["project-root", DATABASE]);
	});

	it("adds a project root to a design that arrives without one", () => {
		const store = createDocumentStore();
		store.getState().load({ nodes: [databaseNode("orders")] });
		expect(ids(store)).toEqual(["project-root", DATABASE]);
	});
});

describe("undo of a field edit", () => {
	it("puts the field back and leaves the node on the board", () => {
		const store = seeded();
		const added = store.getState().addNode("bucket").id;
		store.getState().updateNodeConfig(added, { versioning: true });

		store.getState().undo();

		// The edit is undone; the node that was being edited is still there.
		expect(ids(store)).toContain(added);
		expect(pendingCount(store.getState())).toBe(1);
	});

	it("does not restore an older snapshot over later edits", () => {
		const store = seeded();
		store.getState().addNode("bucket");
		store.getState().updateNodeConfig(DATABASE, { port: 6543 });
		vi.advanceTimersByTime(5000);
		store.getState().updateNodeConfig(DATABASE, { iam_auth: true });

		store.getState().undo();

		// Only the last edit went: the port edit made before it is still in place.
		expect(port(store)).toBe(6543);
		expect(ids(store)).toHaveLength(3);
	});

	it("edits of the same field within a second are one step; a pause makes a second", () => {
		const store = seeded();
		store.getState().updateNodeConfig(DATABASE, { port: 6000 });
		vi.advanceTimersByTime(300);
		store.getState().updateNodeConfig(DATABASE, { port: 6500 });
		vi.advanceTimersByTime(300);
		store.getState().updateNodeConfig(DATABASE, { port: 6543 });
		expect(store.getState().history.past).toHaveLength(1);

		vi.advanceTimersByTime(2000);
		store.getState().updateNodeConfig(DATABASE, { port: 7000 });
		expect(store.getState().history.past).toHaveLength(2);

		store.getState().undo();
		expect(port(store)).toBe(6543);
		store.getState().undo();
		expect(port(store)).toBe(5432);
	});

	it("an edit to a node that is not in the design changes nothing", () => {
		const store = seeded();
		const before = store.getState().designNodes;
		store.getState().updateNodeConfig("addon-grafana", { version: "9" });
		expect(store.getState().designNodes).toBe(before);
		expect(store.getState().history.past).toEqual([]);
	});
});

describe("moves", () => {
	it("a drag is one undo step however many frames it has, and never touches the design", () => {
		const store = seeded();
		const design = store.getState().designNodes;
		const start = store.getState().positions[DATABASE];

		for (let frame = 1; frame <= 30; frame++) {
			store.getState().beginMove();
			store
				.getState()
				.moveNodes({ [DATABASE]: { x: start.x + frame, y: start.y } }, { moving: frame < 30 });
		}

		expect(store.getState().designNodes).toBe(design);
		expect(store.getState().positions[DATABASE]).toEqual({ x: start.x + 30, y: start.y });
		expect(store.getState().history.past).toHaveLength(1);
		expect(store.getState().moving).toBe(false);

		store.getState().undo();
		expect(store.getState().positions[DATABASE]).toEqual(start);
	});

	it("a move is not a pending change", () => {
		const store = seeded();
		store.getState().beginMove();
		store.getState().moveNodes({ [DATABASE]: { x: 5, y: 5 } }, { moving: false });
		expect(pendingCount(store.getState())).toBe(0);
		expect(store.getState().arranged).toBe(true);
	});

	it("arrange re-anchors the collection cards and is one step", () => {
		const store = seeded();
		store.getState().setCollectionPosition("secret", { x: 1, y: 2 });
		store.getState().arrange({ [DATABASE]: { x: 700, y: 700 } });
		expect(store.getState().collectionPositions).toEqual({});
		store.getState().undo();
		expect(store.getState().collectionPositions).toEqual({ secret: { x: 1, y: 2 } });
	});

	it("repairOverlaps pushes apart cards that sit on each other", () => {
		const store = createDocumentStore();
		store.getState().load({ nodes: [projectNode(), databaseNode("a"), databaseNode("b")] });
		store.getState().arrange({ "database-a": { x: 100, y: 100 }, "database-b": { x: 100, y: 100 } });
		store.getState().repairOverlaps();
		const { positions } = store.getState();
		expect(positions["database-a"]).not.toEqual(positions["database-b"]);
	});
});

describe("transact", () => {
	it("makes several changes one undo step", () => {
		const store = seeded();
		store.getState().transact("template", () => {
			store.getState().addNode("bucket");
			store.getState().addNode("queue");
			store.getState().updateNodeConfig(DATABASE, { port: 6543 });
		});
		expect(store.getState().history.past).toHaveLength(1);

		store.getState().undo();
		expect(ids(store)).toEqual(["project-root", DATABASE]);
		expect(port(store)).toBe(5432);
	});

	it("takes checkpoints again once it has finished, even when the change threw", () => {
		const store = seeded();
		expect(() =>
			store.getState().transact("broken", () => {
				throw new Error("apply failed");
			}),
		).toThrow("apply failed");
		store.getState().addNode("bucket");
		store.getState().addNode("queue");
		// The transaction's own step (which restores nothing new) and one for the second add: the
		// first add extended the transaction's step.
		expect(store.getState().history.past).toHaveLength(2);
	});
});

describe("a server design that moved", () => {
	it("replaces a clean draft, and lays an untouched board out afresh", () => {
		const store = seeded();
		const outcome = store
			.getState()
			.reseed(
				{ nodes: [projectNode(), databaseNode("orders", 5433), databaseNode("audit")] },
				{ scope: SCOPE, revision: "r2" },
			);
		expect(outcome).toBe("replaced");
		expect(ids(store)).toEqual(["project-root", DATABASE, "database-audit"]);
		expect(port(store)).toBe(5433);
		expect(pendingCount(store.getState())).toBe(0);
	});

	it("keeps the arrangement a person made for every card that is still there", () => {
		const store = seeded();
		store.getState().beginMove();
		store.getState().moveNodes({ [DATABASE]: { x: 1234, y: 567 } }, { moving: false });

		store
			.getState()
			.reseed(
				{ nodes: [projectNode(), databaseNode("orders"), databaseNode("audit")] },
				{ scope: SCOPE, revision: "r2" },
			);

		expect(store.getState().positions[DATABASE]).toEqual({ x: 1234, y: 567 });
		expect(store.getState().positions["database-audit"]).toBeDefined();
	});

	it("moves only the baseline under a draft with pending changes", () => {
		const store = seeded();
		store.getState().updateNodeConfig(DATABASE, { port: 6543 });
		const draft = store.getState().designNodes;

		const outcome = store
			.getState()
			.reseed(
				{ nodes: [projectNode(), databaseNode("orders"), databaseNode("audit")] },
				{ scope: SCOPE, revision: "r2" },
			);

		expect(outcome).toBe("baseline-moved");
		expect(store.getState().designNodes).toBe(draft);
		expect(store.getState().history.past).toHaveLength(1);
		expect(store.getState().seed).toEqual({ scope: SCOPE, revision: "r2" });
	});

	it("is a no-op for the revision it was seeded from, and a full load for another scope", () => {
		const store = seeded();
		expect(
			store.getState().reseed({ nodes: [projectNode()] }, { scope: SCOPE, revision: "r1" }),
		).toBe("unchanged");
		expect(
			store
				.getState()
				.reseed({ nodes: [projectNode(), cacheNode("s")] }, { scope: "proj-1:env-b", revision: "x" }),
		).toBe("loaded");
		expect(ids(store)).toEqual(["project-root", "cache-s"]);
	});
});

describe("saving and discarding", () => {
	it("commitBaseline clears the pending changes and records the saved revision", () => {
		const store = seeded();
		store.getState().updateNodeConfig(DATABASE, { port: 6543 });
		store.getState().stageOperation(GRAFANA);
		expect(pendingCount(store.getState())).toBe(2);

		store.getState().commitBaseline("r2");

		expect(pendingCount(store.getState())).toBe(0);
		expect(store.getState().seed).toEqual({ scope: SCOPE, revision: "r2" });
		// The server's next render of the revision the save produced is not a foreign change.
		expect(
			store
				.getState()
				.reseed({ nodes: [projectNode(), databaseNode("orders", 6543)] }, { scope: SCOPE, revision: "r2" }),
		).toBe("unchanged");
	});

	it("discard returns to the saved design and drops the staged operations and the history", () => {
		const store = seeded();
		store.getState().addNode("bucket");
		store.getState().stageOperation(GRAFANA);
		store.getState().discard();
		expect(ids(store)).toEqual(["project-root", DATABASE]);
		expect(store.getState().operations).toEqual([]);
		expect(store.getState().history).toEqual({ past: [], future: [] });
	});
});

describe("staged operations", () => {
	it("staging the same target again replaces it, and both are undoable", () => {
		const store = seeded();
		store.getState().stageOperation(GRAFANA);
		store.getState().stageOperation({ ...GRAFANA, summary: "install 8.2.0" });
		expect(store.getState().operations.map((o) => o.summary)).toEqual(["install 8.2.0"]);

		store.getState().undo();
		expect(store.getState().operations.map((o) => o.summary)).toEqual(["install 8.1.2"]);
		store.getState().unstageOperation("addon:grafana");
		expect(store.getState().operations).toEqual([]);
		// Unstaging something that is not staged is not a step.
		const steps = store.getState().history.past.length;
		store.getState().unstageOperation("addon:grafana");
		expect(store.getState().history.past).toHaveLength(steps);
	});
});

describe("the seed slot", () => {
	it("holds an offered hand-off until it is applied, as one undo step", () => {
		const store = seeded();
		expect(
			store
				.getState()
				.offerSeed("v1.template.standard.aws", { kind: "template", templateId: "standard", provider: "aws" }),
		).toBe(true);
		expect(store.getState().seedSlot?.seed.kind).toBe("template");

		const applied = store.getState().consumeSeed(() => {
			store.getState().addNode("bucket");
			store.getState().addNode("queue");
		});

		expect(applied).toBe(true);
		expect(store.getState().seedSlot).toBeNull();
		expect(pendingCount(store.getState())).toBe(2);
		store.getState().undo();
		expect(ids(store)).toEqual(["project-root", DATABASE]);
	});

	it("applying the same hand-off twice is a no-op", () => {
		const store = seeded();
		const seed = { kind: "proposal", proposalId: "p-1" } as const;
		store.getState().offerSeed("v1.proposal.p-1", seed);
		store.getState().consumeSeed(() => store.getState().addNode("bucket"));

		expect(store.getState().offerSeed("v1.proposal.p-1", seed)).toBe(false);
		expect(store.getState().consumeSeed(() => store.getState().addNode("queue"))).toBe(false);
		expect(ids(store)).toHaveLength(3);
		// What is kept is the wire string, whose version travels with it.
		expect(draftOf(store.getState()).appliedSeedKeys).toEqual(["v1.proposal.p-1"]);
	});

	it("tells hand-offs apart by their wire string, not by what they parse to", () => {
		const store = seeded();
		store.getState().offerSeed("v1.blank", { kind: "blank" });
		store.getState().consumeSeed(() => undefined);
		expect(store.getState().offerSeed("v1.blank", { kind: "blank" })).toBe(false);
		expect(store.getState().offerSeed("v1.byo.chart", { kind: "byo", attach: "chart" })).toBe(true);
		expect(store.getState().seedSlot).toEqual({
			wire: "v1.byo.chart",
			seed: { kind: "byo", attach: "chart" },
		});
	});
});

describe("the reviewed plan", () => {
	/** The gate for the store as it stands. */
	function gate(store: DocumentStore) {
		const s = store.getState();
		return deployGate({
			reviewedPlan: s.reviewedPlan,
			designNodes: s.designNodes,
			baseline: s.baseline,
			operations: s.operations,
		});
	}

	it("is current for the design it was recorded on, and stale after any edit", () => {
		const store = seeded();
		expect(gate(store).reason).toBe("no-plan");

		store.getState().recordReviewedPlan("plan-1");
		expect(gate(store)).toEqual({ allowed: true, reason: "ok", planJobId: "plan-1" });

		store.getState().updateNodeConfig(DATABASE, { port: 6543 });
		expect(planReviewState(store.getState().reviewedPlan, store.getState().designNodes)).toBe("stale");
		expect(gate(store).allowed).toBe(false);

		// Undoing the edit returns to the design the plan was computed for.
		store.getState().undo();
		expect(gate(store).allowed).toBe(true);
	});

	it("does not go stale when a card is only moved", () => {
		const store = seeded();
		store.getState().recordReviewedPlan("plan-1");
		store.getState().beginMove();
		store.getState().moveNodes({ [DATABASE]: { x: 9, y: 9 } }, { moving: false });
		expect(gate(store).allowed).toBe(true);
	});

	it("is dropped by a full load and by clearReviewedPlan", () => {
		const store = seeded();
		store.getState().recordReviewedPlan("plan-1");
		store.getState().clearReviewedPlan();
		expect(store.getState().reviewedPlan).toBeNull();
		store.getState().recordReviewedPlan("plan-2");
		store.getState().load({ nodes: [projectNode()] });
		expect(store.getState().reviewedPlan).toBeNull();
	});
});

describe("structure", () => {
	it("a singleton that is already placed is returned, not added again", () => {
		const store = createDocumentStore();
		store.getState().load({ nodes: [projectNode()] });
		const first = store.getState().addNode("cluster");
		const second = store.getState().addNode("cluster");
		expect(first.created).toBe(true);
		expect(second).toEqual({ id: first.id, created: false });
	});

	it("addNodeWithConfig names a node uniquely within its kind and places it where asked", () => {
		const store = seeded();
		const { id } = store
			.getState()
			.addNodeWithConfig("database", { name: "orders" }, null, { x: 40, y: 50 }, "aws");
		const node = store.getState().designNodes.find((n) => n.id === id);
		expect(node?.data.kind === "database" ? node.data.config.name : null).toBe("orders-2");
		expect(node?.data.provider).toBe("aws");
		expect(store.getState().positions[id]).toEqual({ x: 40, y: 50 });
	});

	it("duplicate copies an array-kind node beside the original and leaves singletons alone", () => {
		const store = seeded();
		const cluster = store.getState().addNode("cluster").id;
		const copies = store.getState().duplicateNodes([DATABASE, cluster, "project-root"]);
		expect(copies).toHaveLength(1);
		const from = store.getState().positions[DATABASE];
		expect(store.getState().positions[copies[0]]).toEqual({ x: from.x + 48, y: from.y + 48 });
		expect(diffNodes(store.getState().baseline, store.getState().designNodes).map((c) => c.name)).toContain(
			"orders-copy",
		);
	});

	it("removeNodes keeps the project root and any node marked not deletable", () => {
		const store = createDocumentStore();
		const pinned: CanvasNode = { ...databaseNode("pinned"), deletable: false };
		store.getState().load({ nodes: [projectNode(), databaseNode("orders"), pinned] });
		expect(store.getState().removeNodes(["project-root", DATABASE, "database-pinned"])).toEqual([DATABASE]);
		expect(ids(store)).toEqual(["project-root", "database-pinned"]);
		expect(store.getState().removeNodes(["database-pinned"])).toEqual([]);
	});

	it("setNodeIdentity is one undo step", () => {
		const store = seeded();
		expect(store.getState().setNodeIdentity(DATABASE, "ident-gcp", "gcp")).toEqual([]);
		expect(store.getState().designNodes.find((n) => n.id === DATABASE)?.data.provider).toBe("gcp");
		store.getState().undo();
		expect(store.getState().designNodes.find((n) => n.id === DATABASE)?.data.provider).toBeNull();
	});

	it("redo puts an undone step back, and reset empties the document", () => {
		const store = seeded();
		const added = store.getState().addNode("bucket").id;
		expect(store.getState().undo()).toBe(true);
		expect(store.getState().redo()).toBe(true);
		expect(ids(store)).toContain(added);
		expect(store.getState().redo()).toBe(false);

		store.getState().reset();
		expect(ids(store)).toEqual(["project-root"]);
		expect(store.getState().seed).toBeNull();
		expect(store.getState().undo()).toBe(false);
	});
});
