// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Collection kinds: a real project has 30–40 secrets, and 30–40 cards bury the architecture. They
// collapse into one vault card.
//
// The load-bearing guarantees these tests defend:
//   1. only the VIEW collapses — the store keeps a node per resource, so graphToForm / the staged
//      diff / drift attribution / per-component status are all untouched;
//   2. collapsing never HIDES trouble — the card reports its worst member's state.

import { describe, expect, it } from "vitest";
import {
	aggregateState,
	buildRenderNodes,
	collectionNodeId,
	COLLECTION_KINDS,
	isCollectionKind,
	kindFromCollectionId,
	type CollectionNode,
} from "@/lib/canvas/collections";
import { NODE_REGISTRY } from "@/components/design-project/canvas/graph/node-registry";
import type { CanvasNode, NodeKind } from "@/components/design-project/canvas/graph/types";
import type { NodeStatusState } from "@/lib/canvas/node-status";

function node(kind: NodeKind, name: string, x = 0, y = 0): CanvasNode {
	return {
		id: `${kind}-${name}`,
		type: kind,
		position: { x, y },
		data: {
			kind,
			config: { ...NODE_REGISTRY[kind].defaultData("aws"), name },
			cloud_identity_id: null,
			provider: "aws",
		},
	} as CanvasNode;
}

const isCollection = (n: { type?: string }): n is CollectionNode =>
	n.type === "collection";

describe("which kinds collapse", () => {
	it("secrets do — they're the canonical high-cardinality kind", () => {
		expect(isCollectionKind("secret")).toBe(true);
		expect(COLLECTION_KINDS).toContain("secret");
	});

	it("ordinary resources do not — a database is worth a card of its own", () => {
		expect(isCollectionKind("database")).toBe(false);
		expect(isCollectionKind("cluster")).toBe(false);
	});

	it("collection ids round-trip, and a non-collection id resolves to nothing", () => {
		expect(kindFromCollectionId(collectionNodeId("secret"))).toBe("secret");
		expect(kindFromCollectionId("secret-abc123")).toBeNull();
		// A kind that exists but doesn't collapse must not masquerade as a collection.
		expect(kindFromCollectionId("collection:database")).toBeNull();
	});
});

describe("buildRenderNodes", () => {
	it("collapses every secret into ONE card", () => {
		const nodes = [
			node("database", "orders"),
			...Array.from({ length: 30 }, (_, i) => node("secret", `secret-${i}`)),
		];
		const rendered = buildRenderNodes(nodes, {});

		// 30 secrets + 1 database → 1 vault + 1 database.
		expect(rendered).toHaveLength(2);
		const vault = rendered.find(isCollection);
		expect(vault?.data.memberIds).toHaveLength(30);
		// No individual secret is drawn.
		expect(rendered.some((n) => n.id.startsWith("secret-"))).toBe(false);
	});

	it("leaves non-collection nodes exactly as they are", () => {
		const db = node("database", "orders");
		const [rendered] = buildRenderNodes([db], {});
		expect(rendered).toBe(db);
	});

	it("draws no vault for a kind with no resources — it appears with the first secret", () => {
		expect(buildRenderNodes([node("database", "orders")], {})).toHaveLength(1);
		const withOne = buildRenderNodes(
			[node("database", "orders"), node("secret", "api-key")],
			{},
		);
		expect(withOne.filter(isCollection)).toHaveLength(1);
	});

	it("anchors the vault on its first member until it's been dragged", () => {
		const nodes = [node("secret", "a", 120, 340), node("secret", "b", 340, 340)];
		const vault = buildRenderNodes(nodes, {}).find(isCollection);
		expect(vault?.position).toEqual({ x: 120, y: 340 });
	});

	it("a stored position wins — the vault stays where it was dragged", () => {
		const nodes = [node("secret", "a", 120, 340)];
		const vault = buildRenderNodes(nodes, { secret: { x: 900, y: 60 } }).find(isCollection);
		expect(vault?.position).toEqual({ x: 900, y: 60 });
	});

	it("is never keyboard-deletable — one Backspace must not destroy forty secrets", () => {
		const vault = buildRenderNodes([node("secret", "a")], {}).find(isCollection);
		expect(vault?.deletable).toBe(false);
	});

	it("selects the vault when any member is selected", () => {
		const a = node("secret", "a");
		const b = { ...node("secret", "b"), selected: true };
		const vault = buildRenderNodes([a, b], {}).find(isCollection);
		expect(vault?.selected).toBe(true);
	});

	// The whole reason this is safe: the MODEL is untouched.
	it("does not mutate the store's nodes — collapsing is a view transform only", () => {
		const nodes = [node("secret", "a"), node("secret", "b")];
		const before = structuredClone(nodes);
		buildRenderNodes(nodes, {});
		expect(nodes).toEqual(before);
	});
});

describe("aggregateState — collapsing must never hide trouble", () => {
	it("a vault holding one failed secret can never read Live", () => {
		const states: NodeStatusState[] = ["live", "live", "failed", "live"];
		expect(aggregateState(states)).toBe("failed");
	});

	it("reports the WORST member, in the resolver's own precedence order", () => {
		expect(aggregateState(["live", "needs-setup"])).toBe("needs-setup");
		expect(aggregateState(["needs-setup", "failed"])).toBe("failed");
		expect(aggregateState(["live", "applying"])).toBe("applying");
		expect(aggregateState(["live", "update-pending"])).toBe("update-pending");
	});

	it("a uniformly healthy vault is calm", () => {
		expect(aggregateState(["live", "live"])).toBe("live");
		expect(aggregateState(["ready", "ready"])).toBe("ready");
	});

	it("an empty vault is ready (it can't be broken if it holds nothing)", () => {
		expect(aggregateState([])).toBe("ready");
	});
});
