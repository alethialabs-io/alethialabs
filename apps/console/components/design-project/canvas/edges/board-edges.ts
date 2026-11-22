// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The edges the board DRAWS, from the edges the design derives (#6835).
//
// The store derives one edge per binding, between store nodes. The board draws cards, and a card
// can stand for many nodes (the vault), so an edge is re-pointed at the card that shows its end,
// the copies that creates are folded into one line that knows how many bindings it stands for, and
// every line gets what a person needs from it: a name a screen reader can say, and whether it can
// be removed here or where else it is changed.
//
// Pure, and keyed on nothing that a drag changes, so moving a card rebuilds no edge.

import type { Edge } from "@xyflow/react";
import {
	collectionNodeId,
	isCollectionKind,
} from "@/lib/canvas/collections";
import { NODE_REGISTRY } from "../graph/node-registry";
import type { CanvasEdge, CanvasNode } from "../graph/types";
import { cardIdentity, nodeAccessibleName } from "../nodes/node-name";

/** What a drawn edge knows about itself beyond its two ends. */
export type BoardEdgeData = {
	/** How many bindings the line stands for: more than one only behind a collapsed card. */
	count: number;
	/** Why the line cannot be removed on the board, or null when Delete removes it. */
	locked: string | null;
};

/** An edge as the board draws it. */
export type BoardEdge = Edge<BoardEdgeData>;

/** Why an edge of `type` cannot be removed on the board, or null when it can. */
function lockReason(type: string | undefined): string | null {
	if (type === "binding") return null;
	if (type === "cw_binding") {
		return "This connection belongs to a chart workload. Change it in the workload's inspector.";
	}
	return "This line shows which chart a workload comes from. It is not a connection and cannot be removed.";
}

/**
 * The title of every card, by card id: a store node's own "kind name", and a collection card's
 * plural title. What an edge's name and a card's "Connected to" are built from.
 */
export function cardTitles(nodes: CanvasNode[]): Map<string, string> {
	const titles = new Map<string, string>();
	for (const node of nodes) {
		const { eyebrow, title } = cardIdentity(node.data);
		titles.set(node.id, nodeAccessibleName(eyebrow, title));
		if (isCollectionKind(node.data.kind)) {
			const def = NODE_REGISTRY[node.data.kind];
			titles.set(collectionNodeId(node.data.kind), def.collection?.title ?? def.label);
		}
	}
	return titles;
}

/** The id an edge end points at once collections are collapsed into one card. */
function cardIdFor(id: string, byId: Map<string, CanvasNode>): string {
	const node = byId.get(id);
	if (!node || !isCollectionKind(node.data.kind)) return id;
	return collectionNodeId(node.data.kind);
}

/**
 * The edges to draw: each derived edge between the cards that show its ends, folded where a
 * collapsed card made copies, dropped where an end has no card.
 *
 * @param edges The edges derived from the design.
 * @param nodes Every store node, drawn or not.
 * @param drawn The ids of the cards on the board.
 */
export function buildBoardEdges(
	edges: CanvasEdge[],
	nodes: CanvasNode[],
	drawn: ReadonlySet<string>,
): BoardEdge[] {
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const titles = cardTitles(nodes);
	const folded = new Map<string, BoardEdge>();
	for (const edge of edges) {
		const source = cardIdFor(edge.source, byId);
		const target = cardIdFor(edge.target, byId);
		if (!drawn.has(source) || !drawn.has(target)) continue;
		const key = `${edge.type ?? ""}:${source}->${target}`;
		const seen = folded.get(key);
		if (seen) {
			folded.set(key, { ...seen, data: { count: (seen.data?.count ?? 1) + 1, locked: seen.data?.locked ?? null } });
			continue;
		}
		folded.set(key, {
			// An edge whose ends did not move keeps the id the store gave it, so React Flow keeps its
			// element; a re-pointed one is named for the cards it now joins.
			id: source === edge.source && target === edge.target ? edge.id : key,
			type: edge.type,
			source,
			target,
			focusable: true,
			selectable: true,
			// Removal is the board's own (it edits a binding and takes an undo step), never React
			// Flow's, which would drop the line and leave the binding.
			deletable: false,
			data: { count: 1, locked: lockReason(edge.type) },
		});
	}
	return [...folded.values()].map((edge) => {
		const from = titles.get(edge.source) ?? "a card";
		const to = titles.get(edge.target) ?? "a card";
		const count = edge.data?.count ?? 1;
		const noun = edge.type === "dependency" ? "Link" : "Connection";
		return {
			...edge,
			ariaLabel:
				count > 1 ? `${count} connections from ${from} to ${to}` : `${noun} from ${from} to ${to}`,
		};
	});
}

/** The titles of the cards each card is connected to, by card id, in edge order. */
export function connectionsByCard(
	edges: BoardEdge[],
	titles: ReadonlyMap<string, string>,
): Map<string, string[]> {
	const byCard = new Map<string, string[]>();
	/** Record that `card` is connected to `other`. */
	const add = (card: string, other: string) => {
		const title = titles.get(other);
		if (!title) return;
		const list = byCard.get(card);
		if (list) list.push(title);
		else byCard.set(card, [title]);
	};
	for (const edge of edges) {
		add(edge.source, edge.target);
		add(edge.target, edge.source);
	}
	return byCard;
}
