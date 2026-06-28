"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import {
	Background,
	BackgroundVariant,
	Controls,
	ReactFlow,
	type EdgeTypes,
	type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useCanvasStore } from "@/lib/stores/use-canvas-store";
import type { CanvasNode } from "./graph/types";
import { CacheNode } from "./nodes/cache-node";
import { ClusterNode } from "./nodes/cluster-node";
import { DatabaseNode } from "./nodes/database-node";
import { DnsNode } from "./nodes/dns-node";
import { NetworkNode } from "./nodes/network-node";
import { NosqlNode } from "./nodes/nosql-node";
import { ProjectNode } from "./nodes/project-node";
import { QueueNode } from "./nodes/queue-node";
import { RepositoriesNode } from "./nodes/repositories-node";
import { SecretNode } from "./nodes/secret-node";
import { TopicNode } from "./nodes/topic-node";
import { DependencyEdge } from "./edges/dependency-edge";
import { GatedEdge } from "./edges/gated-edge";

// Defined at module scope so React Flow doesn't warn about new objects per render.
const nodeTypes: NodeTypes = {
	project: ProjectNode,
	network: NetworkNode,
	cluster: ClusterNode,
	database: DatabaseNode,
	cache: CacheNode,
	queue: QueueNode,
	topic: TopicNode,
	nosql: NosqlNode,
	dns: DnsNode,
	secret: SecretNode,
	repositories: RepositoriesNode,
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

	return (
		<ReactFlow<CanvasNode>
			nodes={nodes}
			edges={edges}
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
			proOptions={{ hideAttribution: false }}
			className="bg-background"
		>
			<Background
				variant={BackgroundVariant.Dots}
				gap={16}
				size={1}
				color="var(--border, #e5e5e5)"
			/>
			<Controls showInteractive={false} className="!rounded-none" />
		</ReactFlow>
	);
}
