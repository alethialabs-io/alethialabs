// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// W3 — automatic graph layout via elkjs (the layered algorithm). The board arranges itself into
// tiers — workloads above the backing infra they bind to, edges routed — instead of the old blind
// cascade offset. A manual drag still wins (the store keeps the dragged position until the next
// arrange), so this is auto-layout AND manual override, not one or the other.

import ELK from "elkjs/lib/elk.bundled.js";
import type { XYPosition } from "@xyflow/react";

const elk = new ELK();

/** Approximate card footprint when React Flow hasn't measured a node yet (first arrange). */
const DEFAULT_W = 240;
const DEFAULT_H = 120;

export interface LayoutNode {
	id: string;
	width?: number | null;
	height?: number | null;
}
export interface LayoutEdge {
	id: string;
	source: string;
	target: string;
}

/**
 * Lay out `nodes` (with `edges` as the routing hints) into a top-down layered arrangement and return
 * the computed top-left position per node id. Pure/async — it reads no store and mutates nothing; the
 * caller applies the positions. An empty node set returns `{}`.
 */
export async function elkLayout(
	nodes: LayoutNode[],
	edges: LayoutEdge[],
): Promise<Record<string, XYPosition>> {
	if (nodes.length === 0) return {};
	const ids = new Set(nodes.map((n) => n.id));
	const graph = {
		id: "root",
		layoutOptions: {
			"elk.algorithm": "layered",
			"elk.direction": "DOWN",
			"elk.spacing.nodeNode": "48",
			"elk.layered.spacing.nodeNodeBetweenLayers": "88",
			"elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
		},
		children: nodes.map((n) => ({
			id: n.id,
			width: n.width ?? DEFAULT_W,
			height: n.height ?? DEFAULT_H,
		})),
		// Only edges whose BOTH endpoints are in the laid-out set (a binding to an unplaced resource
		// draws nothing and must not confuse the layout).
		edges: edges
			.filter((e) => ids.has(e.source) && ids.has(e.target))
			.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
	};
	const res = await elk.layout(graph);
	const out: Record<string, XYPosition> = {};
	for (const c of res.children ?? []) {
		if (typeof c.x === "number" && typeof c.y === "number") {
			out[c.id] = { x: c.x, y: c.y };
		}
	}
	return out;
}
