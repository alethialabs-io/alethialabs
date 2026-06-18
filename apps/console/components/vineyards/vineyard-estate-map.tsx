"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only


import {
	addEdge,
	Background,
	Connection,
	Controls,
	Edge,
	MiniMap,
	NodeTypes,
	ReactFlow,
	useEdgesState,
	useNodesState,
} from "@xyflow/react";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useMemo } from "react";
import { VineNode, type VineNodeConfig } from "./vine-node";

interface VineyardEstateMapProps {
	vineyard: { vines?: VineNodeConfig[] | null };
}

const nodeTypes: NodeTypes = {
	vineNode: VineNode,
};

export function VineyardEstateMap({ vineyard }: VineyardEstateMapProps) {
	const router = useRouter();
	const { id: vineyardId } = useParams<{ id: string }>();

	const initialNodes = useMemo(() => {
		return (vineyard.vines || []).map(
			(config: VineNodeConfig, index: number) => ({
				id: `vine-${config.id}`,
				type: "vineNode",
				position: {
					x: config.ui_position_x || 250 + index * 300,
					y: config.ui_position_y || 150 + index * 50,
				},
				data: {
					config,
					onClick: () => {
						router.push(`/dashboard/vineyards/${vineyardId}/vines/${config.id}`);
					},
				},
			}),
		);
	}, [vineyard.vines, router, vineyardId]);

	// Create initial edges (empty for now unless we add harvests/tendrils)
	const initialEdges: Edge[] = [];

	const [nodes, _setNodes, onNodesChange] = useNodesState(initialNodes);
	const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

	const onConnect = useCallback(
		(params: Connection | Edge) => setEdges((eds) => addEdge(params, eds)),
		[setEdges],
	);

	return (
		<div style={{ width: "100%", height: "100%" }}>
			<ReactFlow
				nodes={nodes}
				edges={edges}
				onNodesChange={onNodesChange}
				onEdgesChange={onEdgesChange}
				onConnect={onConnect}
				nodeTypes={nodeTypes}
				fitView
				className="bg-muted/10"
				minZoom={0.2}
				maxZoom={1.5}
			>
				<Controls showInteractive={false} />
				<MiniMap
					zoomable
					pannable
					nodeClassName="bg-muted-foreground/20"
				/>
				<Background
					gap={24}
					size={1}
					className="bg-background"
					color="hsl(var(--muted-foreground) / 0.2)"
				/>
			</ReactFlow>

		</div>
	);
}
