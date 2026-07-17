// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Collection kinds — the fix for high-cardinality resources.
//
// A real project carries 30–40 secrets. Drawn as 30–40 full cards they bury the architecture: the
// canvas stops being a picture of the system and becomes a wall of near-identical boxes. So a kind
// can declare itself a COLLECTION: every node of that kind collapses into ONE card on the board
// (a vault), and the individual resources are managed as a list inside its panel.
//
// The crucial part: only the VIEW collapses. The store still holds one node per secret, so
// graphToForm, the staged-change diff, drift attribution, and per-component status all keep working
// exactly as before — a collection is a rendering decision, not a data model.

import { typedValues } from "@/lib/typed-object";
import type { Node, XYPosition } from "@xyflow/react";
import {
	NODE_REGISTRY,
	type NodeKindDef,
} from "@/components/design-project/canvas/graph/node-registry";
import type {
	CanvasNode,
	NodeKind,
} from "@/components/design-project/canvas/graph/types";
import type { NodeStatusState } from "./node-status";

/** The kinds that collapse into a single card. Derived from the registry — never hand-listed. */
export const COLLECTION_KINDS: NodeKind[] = typedValues(NODE_REGISTRY)
	.filter((def) => def.collection)
	.map((def) => def.kind);

/** True when this kind renders as one collapsed card rather than one card per resource. */
export function isCollectionKind(kind: NodeKind): boolean {
	return !!NODE_REGISTRY[kind].collection;
}

/** The synthetic id of a kind's collection card. Never a real node id — it has no store row. */
export function collectionNodeId(kind: NodeKind): string {
	return `collection:${kind}`;
}

/** The kind behind a collection id, or null when the id isn't one. */
export function kindFromCollectionId(id: string): NodeKind | null {
	if (!id.startsWith("collection:")) return null;
	const kind = id.slice("collection:".length) as NodeKind;
	return kind in NODE_REGISTRY && isCollectionKind(kind) ? kind : null;
}

/**
 * Worst-first ranking of node states — the same precedence the status resolver uses, reused here so
 * a collection card reports the state of its unhappiest member. A vault holding one FAILED secret
 * must not read "Live"; the whole point of collapsing is that you can still see trouble inside.
 */
const SEVERITY: NodeStatusState[] = [
	"failed",
	"unreachable",
	"needs-setup",
	"applying",
	"updating",
	"destroying",
	"queued",
	"gated",
	"update-pending",
	"destroyed",
	"not-deployed",
	"live",
	"ready",
];

/** The state a collection card shows: its worst member's. Empty → `ready`. */
export function aggregateState(states: NodeStatusState[]): NodeStatusState {
	for (const state of SEVERITY) {
		if (states.includes(state)) return state;
	}
	return "ready";
}

/** The data a collection card carries. */
export type CollectionNodeData = {
	kind: NodeKind;
	/** Store ids of the nodes this card stands for. */
	memberIds: string[];
};

/** The synthetic React Flow node a collection renders as. It has NO row in the canvas store. */
export type CollectionNode = Node<CollectionNodeData, "collection">;

/** Everything the board can draw: real design nodes, plus the synthetic collection cards. */
export type BoardNode = CanvasNode | CollectionNode;

/** Where a kind's collection card sits. Members' own positions are never drawn, so they don't matter. */
export type CollectionPositions = Partial<Record<NodeKind, XYPosition>>;

/**
 * The nodes the board actually draws: every non-collection node as-is, plus one collection card per
 * collection kind that has at least one member (a kind with no resources has no card — the vault
 * appears when you add the first secret).
 *
 * Members are removed from the render list entirely. They stay in the store, which is what keeps the
 * whole persistence + diff + status machinery untouched.
 */
export function buildRenderNodes(
	nodes: CanvasNode[],
	positions: CollectionPositions,
): BoardNode[] {
	const rendered: BoardNode[] = [];
	const members = new Map<NodeKind, CanvasNode[]>();

	for (const node of nodes) {
		if (isCollectionKind(node.data.kind)) {
			const list = members.get(node.data.kind);
			if (list) list.push(node);
			else members.set(node.data.kind, [node]);
			continue;
		}
		rendered.push(node);
	}

	for (const [kind, list] of members) {
		rendered.push({
			id: collectionNodeId(kind),
			type: "collection",
			// A stored position wins; otherwise anchor on the first member so a freshly-loaded graph
			// puts the vault roughly where its resources were laid out.
			position: positions[kind] ?? list[0].position,
			// Collections are never keyboard-deletable: one Backspace must not silently destroy 40
			// secrets. Removal is per-resource, from the panel.
			deletable: false,
			selected: list.some((n) => n.selected),
			data: { kind, memberIds: list.map((n) => n.id) },
		});
	}

	return rendered;
}
