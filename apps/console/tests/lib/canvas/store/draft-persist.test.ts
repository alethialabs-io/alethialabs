// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The draft's stored format (#6764): what version 2 holds, how a version-1 draft is read, and that
// a value which is not a draft is reported as unreadable rather than half-read.
//
// The version-1 blobs here are typed by hand. `tests/fixtures/canvas/draft-v1.json` is the fixed
// point the store-level test reads; these cover what that fixture does not carry — the retired
// `containerGeometry` with boxes in it, stored edges, React Flow's flags, and out-of-band cards.

import { describe, expect, it } from "vitest";
import {
	DRAFT_VERSION,
	draftStorageKey,
	isNodeKind,
	parseDraft,
	readDraft,
	serializeDraft,
	UNPLACED,
	unplaced,
	writeDraft,
	type DraftState,
} from "@/lib/canvas/store/draft-persist";
import draftV1 from "@/tests/fixtures/canvas/draft-v1.json";
import { addonNode, databaseNode, projectNode } from "@/tests/fixtures/canvas/nodes";

/** A version-1 draft as an older tab holds it: with everything version 2 no longer stores. */
function v1Blob(): string {
	return JSON.stringify({
		state: {
			nodes: [
				projectNode(),
				{ ...databaseNode("orders", 6543), selected: true, measured: { width: 240, height: 130 } },
				addonNode("grafana"),
			],
			edges: [{ id: "e1", source: "a", target: "b" }],
			baseline: [projectNode(), databaseNode("orders"), addonNode("grafana")],
			collectionPositions: { secret: { x: 40, y: 80 }, "not-a-kind": { x: 1, y: 1 } },
			containerGeometry: { cluster: { x: 0, y: 0, width: 900, height: 600 } },
			seed: { scope: "proj-1:env-a", revision: "rev-1" },
			dirty: true,
		},
		version: 1,
	});
}

/** A version-2 draft with one edit pending. */
function v2Draft(): DraftState {
	return {
		designNodes: [unplaced(projectNode()), unplaced(databaseNode("orders", 6543))],
		positions: { "project-root": { x: 0, y: 0 }, "database-orders": { x: 420, y: 260 } },
		collectionPositions: { secret: { x: 40, y: 80 } },
		baseline: [projectNode(), databaseNode("orders")],
		seed: { scope: "proj-1:env-a", revision: "rev-1" },
		operations: [
			{
				id: "addon:grafana",
				target: "addon",
				verb: "install",
				targetId: "grafana",
				summary: "install 8.1.2",
				input: { version: "8.1.2" },
			},
		],
		arranged: true,
		appliedSeedKeys: ["blank"],
	};
}

describe("a version-1 draft", () => {
	it("migrates: positions are lifted off the nodes and nothing derivable is carried over", () => {
		const draft = parseDraft(v1Blob());
		if (!draft) throw new Error("the version-1 draft did not parse");

		expect(draft.designNodes.map((n) => n.id)).toEqual(["project-root", "database-orders"]);
		expect(draft.designNodes.every((n) => n.position === UNPLACED)).toBe(true);
		expect(draft.positions["database-orders"]).toEqual({ x: 120, y: 340 });
		expect(draft.seed).toEqual({ scope: "proj-1:env-a", revision: "rev-1" });
		expect(draft.operations).toEqual([]);
		expect(draft.appliedSeedKeys).toEqual([]);
		// The key set is version 2's: no edges, no dirty flag, no container geometry.
		expect(Object.keys(draft).sort()).toEqual([
			"appliedSeedKeys",
			"arranged",
			"baseline",
			"collectionPositions",
			"designNodes",
			"operations",
			"positions",
			"seed",
		]);
	});

	it("drops the retired container geometry even when it holds boxes", () => {
		const draft = parseDraft(v1Blob());
		expect(JSON.stringify(draft)).not.toContain("containerGeometry");
		expect(JSON.stringify(draft)).not.toContain("900");
	});

	it("drops cards the design does not own from the design and the baseline, keeping where they sat", () => {
		const draft = parseDraft(v1Blob());
		if (!draft) throw new Error("the version-1 draft did not parse");
		expect(draft.baseline.map((n) => n.id)).toEqual(["project-root", "database-orders"]);
		expect(draft.positions["addon-grafana"]).toEqual({ x: 120, y: 520 });
	});

	it("leaves React Flow's flags behind and keeps the config edit", () => {
		const draft = parseDraft(v1Blob());
		if (!draft) throw new Error("the version-1 draft did not parse");
		const orders = draft.designNodes[1];
		expect("selected" in orders).toBe(false);
		expect("measured" in orders).toBe(false);
		expect(orders.data.kind === "database" ? orders.data.config.port : null).toBe(6543);
	});

	it("reads a stored dirty flag as an arranged board, and a collection position by its kind", () => {
		const draft = parseDraft(v1Blob());
		expect(draft?.arranged).toBe(true);
		expect(draft?.collectionPositions).toEqual({ secret: { x: 40, y: 80 } });
	});

	it("reads the hand-written fixture", () => {
		const draft = parseDraft(JSON.stringify(draftV1));
		expect(draft?.designNodes.map((n) => n.id)).toEqual(draftV1.state.nodes.map((n) => n.id));
		expect(draft?.baseline).toEqual(draftV1.state.baseline);
	});
});

describe("a version-2 draft", () => {
	it("round-trips through the slot's string form", () => {
		const draft = v2Draft();
		expect(parseDraft(serializeDraft(draft))).toEqual(draft);
	});

	it("is written at the current version, with no position on a design node", () => {
		const stored = JSON.parse(serializeDraft(v2Draft()));
		expect(stored.version).toBe(DRAFT_VERSION);
		expect(stored.version).toBe(2);
		expect(stored.state.designNodes.every((n: object) => !("position" in n))).toBe(true);
		expect(stored.state.baseline.every((n: object) => "position" in n)).toBe(true);
	});

	it("is read back from the slot it was written to", () => {
		sessionStorage.clear();
		const key = draftStorageKey("proj-1:env-a");
		expect(key).toBe("design-project-canvas-draft:proj-1:env-a");
		expect(readDraft(key)).toBeNull();
		writeDraft(key, v2Draft());
		expect(readDraft(key)).toEqual(v2Draft());
	});
});

describe("a value that is not a draft", () => {
	it.each([
		["text that is not JSON", "{nope"],
		["JSON with no envelope", JSON.stringify({ nodes: [] })],
		["a version this code does not know", JSON.stringify({ state: {}, version: 3 })],
		["version 2 with a key missing", JSON.stringify({ state: { designNodes: [] }, version: 2 })],
		[
			"a node of a kind that does not exist",
			JSON.stringify({
				state: {
					nodes: [{ id: "x", position: { x: 0, y: 0 }, data: { kind: "teapot", config: {} } }],
					baseline: [],
				},
				version: 1,
			}),
		],
		[
			"a node with no config",
			JSON.stringify({
				state: {
					nodes: [{ id: "x", position: { x: 0, y: 0 }, data: { kind: "database" } }],
					baseline: [],
				},
				version: 1,
			}),
		],
	])("is unreadable: %s", (_what, raw) => {
		expect(parseDraft(raw)).toBeNull();
	});

	it("isNodeKind accepts a registry kind and refuses an inherited object key", () => {
		expect(isNodeKind("database")).toBe(true);
		expect(isNodeKind("toString")).toBe(false);
	});
});
