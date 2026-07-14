"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import {
	Background,
	BackgroundVariant,
	ReactFlow,
	type EdgeTypes,
	type NodeChange,
	type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useMemo } from "react";
import {
	buildRenderNodes,
	collectionNodeId,
	isCollectionKind,
	kindFromCollectionId,
	type BoardNode,
} from "@/lib/canvas/collections";
import { useCanvasStore } from "@/lib/stores/use-canvas-store";
import type { CanvasNode, NodeKind } from "./graph/types";
import { NODE_REGISTRY } from "./graph/node-registry";
import { ChartNode } from "./nodes/chart-node";
import { CollectionNode } from "./nodes/collection-node";
import { ServiceNode } from "./nodes/service-node";
import { DependencyEdge } from "./edges/dependency-edge";
import { GatedEdge } from "./edges/gated-edge";

// Every registry kind renders through the ONE data-driven card (ServiceNode → BaseNode), which
// reads its facts + handles from NODE_REGISTRY — so a new kind is picked up here automatically and
// this map can't drift from the SSOT. `chart` keeps its own component: BYO charts are persisted
// out-of-band and carry detach / rescan actions, so they're more than a card.
// Defined at module scope so React Flow doesn't warn about new objects per render.
const nodeTypes: NodeTypes = {
	...Object.fromEntries(
		(Object.keys(NODE_REGISTRY) as NodeKind[]).map((kind) => [kind, ServiceNode]),
	),
	chart: ChartNode,
	// The collapsed card for a high-cardinality kind (the Secrets vault). Synthetic — it has no
	// store row; `buildRenderNodes` creates it from the members.
	collection: CollectionNode,
};

const edgeTypes: EdgeTypes = {
	dependency: DependencyEdge,
	gated: GatedEdge,
};

/** The React Flow surface, controlled by the canvas store. */
export function CanvasFlow() {
	const nodes = useCanvasStore((s) => s.nodes);
	const edges = useCanvasStore((s) => s.edges);
	const onNodesChange = useCanvasStore((s) => s.onNodesChange);
	const openInspector = useCanvasStore((s) => s.openInspector);
	const showConnections = useCanvasStore((s) => s.showConnections);
	const hiddenKinds = useCanvasStore((s) => s.hiddenKinds);
	const collectionPositions = useCanvasStore((s) => s.collectionPositions);
	const setCollectionPosition = useCanvasStore((s) => s.setCollectionPosition);

	// Visibility layers hide whole node groups; connections toggle hides all edges.
	// Edges to/from a hidden node are dropped so none dangle. The project root is the graph's
	// data anchor (name/region/core identity) but is never drawn — it's edited via the toolbar's
	// Project settings button instead.
	const designNodes = nodes.filter(
		(n) => n.data.kind !== "project" && !hiddenKinds.includes(n.data.kind),
	);

	// High-cardinality kinds (secrets) collapse into ONE card. This is a VIEW transform only — the
	// store keeps a node per resource, so the diff / status / persistence machinery is untouched.
	const visibleNodes = useMemo(
		() => buildRenderNodes(designNodes, collectionPositions),
		[designNodes, collectionPositions],
	);

	// A collapsed member has no card of its own, so an edge pointing at it would dangle. Re-target
	// those edges at the collection card and drop the duplicates the collapse creates.
	const visibleIds = new Set(visibleNodes.map((n) => n.id));
	const visibleEdges = showConnections
		? dedupeEdges(
				edges
					.map((e) => ({
						...e,
						source: renderTargetFor(e.source, nodes),
						target: renderTargetFor(e.target, nodes),
					}))
					.filter((e) => visibleIds.has(e.source) && visibleIds.has(e.target)),
			)
		: [];

	return (
		<ReactFlow<BoardNode>
			nodes={visibleNodes}
			edges={visibleEdges}
			onNodesChange={(changes) => {
				// A collection card has no row in the store, so its changes must never reach
				// applyNodeChanges — that would try to patch a node that doesn't exist. Peel them off:
				// a drag becomes the collection's own persisted position, and everything else about a
				// collection is ignored rather than allowed to corrupt the graph. (They're
				// `deletable: false`, so a stray Backspace can't wipe forty secrets either.)
				const passthrough: NodeChange<CanvasNode>[] = [];
				for (const change of changes) {
					const id = "id" in change ? change.id : null;
					const kind = id ? kindFromCollectionId(id) : null;
					if (kind) {
						if (change.type === "position" && change.position) {
							setCollectionPosition(kind, change.position);
						}
						continue;
					}
					// Everything left refers to a real store node. React Flow types the change against
					// the board's union; narrowing it back is sound precisely because the collection
					// ids — the only source of CollectionNode changes — were just filtered out.
					passthrough.push(change as NodeChange<CanvasNode>);
				}
				if (passthrough.length) onNodesChange(passthrough);
			}}
			nodeTypes={nodeTypes}
			edgeTypes={edgeTypes}
			onNodeClick={(_, node) => openInspector(node.id)}
			onPaneClick={() => openInspector(null)}
			deleteKeyCode={["Backspace", "Delete"]}
			fitView
			fitViewOptions={{ padding: 0.3, maxZoom: 1 }}
			minZoom={0.3}
			maxZoom={1.5}
			proOptions={{ hideAttribution: true }}
			className="bg-background"
		>
			<Background
				variant={BackgroundVariant.Dots}
				gap={16}
				size={1}
				color="var(--border, #e5e5e5)"
			/>
		</ReactFlow>
	);
}

/** The id an edge endpoint should point at once collections are collapsed. */
function renderTargetFor(id: string, nodes: CanvasNode[]): string {
	const node = nodes.find((n) => n.id === id);
	if (!node || !isCollectionKind(node.data.kind)) return id;
	return collectionNodeId(node.data.kind);
}

/** Collapsing N members onto one card turns N edges into N copies of the same edge. Keep one. */
function dedupeEdges<E extends { source: string; target: string }>(edges: E[]): E[] {
	const seen = new Set<string>();
	return edges.filter((e) => {
		const key = `${e.source}->${e.target}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}
