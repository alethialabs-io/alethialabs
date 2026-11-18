// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The legacy `useCanvasStore` API over the split stores (#6764). The store's own behaviour is
// pinned by `tests/lib/stores/use-canvas-store-*.test.ts`; this file pins what is specific to it
// being a PROJECTION: every key lands in the store that owns it, cards the design does not own
// stay out of the document and the draft, and one command is one change to a subscriber.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { board } from "@/lib/canvas/store/board";
import { parseDraft } from "@/lib/canvas/store/draft-persist";
import {
	draftStorageKey,
	selectInspectorNodeId,
	switchDraftScope,
	useCanvasStore,
} from "@/lib/stores/use-canvas-store";
import {
	addonNode,
	cacheNode,
	chartWorkloadNode,
	databaseNode,
	projectNode,
} from "@/tests/fixtures/canvas/nodes";

const SCOPE = "proj-1:env-a";
const DATABASE = "database-orders";
const GRAFANA = { id: "grafana", name: "Grafana", version: "8.1.2", namespace: "monitoring" };

/** The legacy store's state. */
function legacy() {
	return useCanvasStore.getState();
}

/** Seed the board from a saved design: the project root and one database. */
function seed() {
	legacy().reseed(
		{ nodes: [projectNode(), databaseNode("orders")] },
		{ scope: SCOPE, revision: "r1" },
	);
}

beforeEach(() => {
	// Back onto the un-scoped slot first: the reset writes the draft, and a test that pointed the
	// draft at a scope must not have the next test's reset land in that scope's slot.
	useCanvasStore.persist.setOptions({ name: "design-project-canvas-draft" });
	legacy().reset();
	sessionStorage.clear();
});

describe("where each key lives", () => {
	it("the design is in the document; a card the design does not own is not", () => {
		seed();
		legacy().setAddonNodes([GRAFANA]);

		expect(legacy().nodes.map((n) => n.id)).toEqual(["project-root", DATABASE, "addon-grafana"]);
		expect(board.document.getState().designNodes.map((n) => n.id)).toEqual(["project-root", DATABASE]);
	});

	it("a card the design does not own never reaches the draft", async () => {
		await switchDraftScope(SCOPE);
		seed();
		legacy().setAddonNodes([GRAFANA]);
		legacy().updateNodeConfig(DATABASE, { port: 6543 });

		const raw = sessionStorage.getItem(draftStorageKey(SCOPE));
		expect(raw).not.toBeNull();
		expect(raw).not.toContain("grafana");
		expect(parseDraft(raw ?? "")?.designNodes.map((n) => n.id)).toEqual(["project-root", DATABASE]);
	});

	it("setState routes nodes, baseline, the card and the selection to their stores", () => {
		const nodes = [projectNode(), databaseNode("orders", 6543), addonNode("grafana")];
		useCanvasStore.setState({
			nodes,
			baseline: [projectNode(), databaseNode("orders")],
			card: { kind: "inspector", nodeId: DATABASE },
			selectedIds: [DATABASE],
			past: [],
			future: [],
		});

		expect(board.document.getState().designNodes.map((n) => n.id)).toEqual(["project-root", DATABASE]);
		expect(board.view.getState().subject).toEqual({ kind: "node", id: DATABASE });
		expect(board.view.getState().selection).toEqual([DATABASE]);
		expect(legacy().nodes).toEqual(nodes);
		expect(legacy().dirty).toBe(true);
		expect(selectInspectorNodeId(legacy())).toBe(DATABASE);
	});

	it("setState takes a function of the current state, and a history as node sets", () => {
		seed();
		const before = legacy().nodes;
		useCanvasStore.setState((s) => ({ nodes: [...s.nodes, cacheNode("sessions")], past: [before] }));

		expect(legacy().nodes.map((n) => n.id)).toContain("cache-sessions");
		expect(legacy().past).toHaveLength(1);
		legacy().undo();
		expect(legacy().nodes.map((n) => n.id)).toEqual(before.map((n) => n.id));
	});

	it("setState keeps React Flow's flags on the nodes it is given", () => {
		useCanvasStore.setState({ nodes: [projectNode(), { ...databaseNode("orders"), selected: true }] });
		expect(legacy().nodes[1].selected).toBe(true);
		expect("selected" in board.document.getState().designNodes[1]).toBe(false);
	});

	it("view preferences, identities and the seed are written where they are read", () => {
		useCanvasStore.setState({
			showConnections: false,
			hiddenKinds: ["database"],
			identities: [{ id: "ident-aws", name: "prod", displayId: "1", provider: "aws" }],
			iacOutputs: ["db_url"],
			seed: { scope: SCOPE, revision: "r7" },
			cardBack: { kind: "activity" },
			collectionPositions: { secret: { x: 1, y: 2 } },
		});
		const s = legacy();
		expect(s.showConnections).toBe(false);
		expect(s.hiddenKinds).toEqual(["database"]);
		expect(s.identities).toHaveLength(1);
		expect(s.iacOutputs).toEqual(["db_url"]);
		expect(s.seed).toEqual({ scope: SCOPE, revision: "r7" });
		expect(s.cardBack).toEqual({ kind: "activity" });
		expect(s.collectionPositions).toEqual({ secret: { x: 1, y: 2 } });
	});
});

describe("dirty", () => {
	it("is what differs from the saved design: an edit sets it, undoing the edit clears it", () => {
		seed();
		expect(legacy().dirty).toBe(false);
		legacy().updateNodeConfig(DATABASE, { port: 6543 });
		expect(legacy().dirty).toBe(true);
		legacy().undo();
		expect(legacy().dirty).toBe(false);
	});

	it("is not set by moving a card", () => {
		seed();
		legacy().onNodesChange([
			{ id: DATABASE, type: "position", position: { x: 9, y: 9 }, dragging: false },
		]);
		expect(legacy().dirty).toBe(false);
	});

	it("written true through setState, it holds until the next save, discard or load", () => {
		seed();
		useCanvasStore.setState({ dirty: true });
		expect(legacy().dirty).toBe(true);
		legacy().commitBaseline();
		expect(legacy().dirty).toBe(false);

		useCanvasStore.setState({ dirty: true });
		legacy().discardChanges();
		expect(legacy().dirty).toBe(false);

		useCanvasStore.setState({ dirty: true });
		legacy().setGraph({ nodes: [projectNode()] });
		expect(legacy().dirty).toBe(false);
	});
});

describe("cards the design does not own", () => {
	it("an edit to one changes the card and is not an undo step", () => {
		seed();
		useCanvasStore.setState((s) => ({ nodes: [...s.nodes, chartWorkloadNode("w1", "pg", [])] }));
		const steps = legacy().past.length;

		legacy().updateNodeConfig("cw-w1", { name: "worker" });

		const card = legacy().nodes.find((n) => n.id === "cw-w1");
		expect(card?.data.kind === "chart_workload" ? card.data.config.name : null).toBe("worker");
		expect(legacy().past).toHaveLength(steps);
		expect(legacy().dirty).toBe(false);
	});

	it("discard and a reset of the scope leave the design's own nodes and drop nothing of theirs", () => {
		seed();
		legacy().setAddonNodes([GRAFANA]);
		legacy().addNode("bucket");
		legacy().discardChanges();
		expect(legacy().nodes.map((n) => n.id)).toEqual(["project-root", DATABASE, "addon-grafana"]);
	});

	it("an empty read for a kind that has no cards changes nothing", () => {
		seed();
		const before = legacy().nodes;
		legacy().setAddonNodes([]);
		legacy().setChartNodes([]);
		legacy().setIacNodes([]);
		expect(legacy().nodes).toBe(before);
	});

	it("repairOverlaps moves a card off a design node it sits on", () => {
		seed();
		legacy().setAddonNodes([GRAFANA]);
		const database = legacy().nodes.find((n) => n.id === DATABASE);
		if (!database) throw new Error("the seeded database is not on the board");
		legacy().onNodesChange([
			{ id: "addon-grafana", type: "position", position: database.position, dragging: false },
		]);
		legacy().repairOverlaps();
		const addon = legacy().nodes.find((n) => n.id === "addon-grafana");
		expect(addon?.position).not.toEqual(database.position);
	});
});

describe("one command, one change", () => {
	it("a subscriber never sees a card open on a node that is not on the board yet", () => {
		seed();
		const seen: boolean[] = [];
		const unsubscribe = useCanvasStore.subscribe((s) => {
			const id = selectInspectorNodeId(s);
			seen.push(id === null || s.nodes.some((n) => n.id === id));
		});
		legacy().addNode("bucket");
		legacy().removeNodes([legacy().selectedIds[0]]);
		unsubscribe();
		expect(seen.length).toBeGreaterThan(0);
		expect(seen.every(Boolean)).toBe(true);
	});

	it("add is one notification, not one per store", () => {
		seed();
		const listener = vi.fn();
		const unsubscribe = useCanvasStore.subscribe(listener);
		legacy().addNode("bucket");
		unsubscribe();
		expect(listener).toHaveBeenCalledTimes(1);
	});
});

describe("the rest of the legacy surface", () => {
	it("resolves identities and providers from the mirrored list and the stamped provider", () => {
		seed();
		legacy().setIdentities([{ id: "ident-gcp", name: "data", displayId: "2", provider: "gcp" }]);
		const id = legacy().addNodeWithConfig("database", { name: "audit" }, "ident-gcp");
		expect(legacy().getEffectiveProvider(id)).toBe("gcp");
		expect(legacy().getEffectiveIdentity(id)?.id).toBe("ident-gcp");
		expect(legacy().getCoreIdentity()).toBeNull();
		expect(legacy().setNodeIdentity(id, null, null)).toEqual([]);
	});

	it("duplicate, arrange, the collection position and the view toggles reach their stores", () => {
		seed();
		legacy().duplicateNodes([DATABASE]);
		expect(legacy().nodes.filter((n) => n.data.kind === "database")).toHaveLength(2);
		legacy().arrange({ [DATABASE]: { x: 700, y: 700 } });
		expect(legacy().nodes.find((n) => n.id === DATABASE)?.position).toEqual({ x: 700, y: 700 });
		legacy().setCollectionPosition("secret", { x: 3, y: 4 });
		expect(legacy().collectionPositions).toEqual({ secret: { x: 3, y: 4 } });
		legacy().toggleConnections();
		legacy().toggleKindVisibility("cache");
		expect(legacy().showConnections).toBe(board.view.getState().showConnections);
		expect(legacy().hiddenKinds).toContain("cache");
		legacy().toggleKindVisibility("cache");
		legacy().toggleConnections();
	});

	it("a detour and its way back, and closing the rail", () => {
		legacy().openCard({ kind: "activity" });
		legacy().openCard({ kind: "env-settings" }, { back: true });
		expect(legacy().cardBack).toEqual({ kind: "activity" });
		legacy().goBackCard();
		expect(legacy().card).toEqual({ kind: "activity" });
		legacy().closeCard();
		expect(legacy().card).toBeNull();
	});

	it("persist.setOptions redirects the draft's writes", () => {
		useCanvasStore.persist.setOptions({ name: "elsewhere" });
		seed();
		expect(sessionStorage.getItem("elsewhere")).not.toBeNull();
		expect(sessionStorage.getItem(draftStorageKey(SCOPE))).toBeNull();
	});

	it("records the revision a save produced and the BYO-IaC outputs", () => {
		seed();
		legacy().setSeedRevision("r9");
		expect(legacy().seed).toEqual({ scope: SCOPE, revision: "r9" });
		legacy().setIacOutputs(["vpc_id"]);
		expect(legacy().iacOutputs).toEqual(["vpc_id"]);
		legacy().redo();
		expect(legacy().future).toEqual([]);
	});
});
