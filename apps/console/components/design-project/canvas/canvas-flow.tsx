"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import {
	Background,
	BackgroundVariant,
	ReactFlow,
	type EdgeTypes,
	type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useCanvasStore } from "@/lib/stores/use-canvas-store";
import type { CanvasNode, NodeKind } from "./graph/types";
import { NODE_REGISTRY } from "./graph/node-registry";
import { ChartNode } from "./nodes/chart-node";
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

	// Visibility layers hide whole node groups; connections toggle hides all edges.
	// Edges to/from a hidden node are dropped so none dangle. The project root is the graph's
	// data anchor (name/region/core identity) but is never drawn — it's edited via the toolbar's
	// Project settings button instead.
	const visibleNodes = nodes.filter(
		(n) => n.data.kind !== "project" && !hiddenKinds.includes(n.data.kind),
	);
	const visibleIds = new Set(visibleNodes.map((n) => n.id));
	const visibleEdges = showConnections
		? edges.filter((e) => visibleIds.has(e.source) && visibleIds.has(e.target))
		: [];

	return (
		<ReactFlow<CanvasNode>
			nodes={visibleNodes}
			edges={visibleEdges}
			onNodesChange={onNodesChange}
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
