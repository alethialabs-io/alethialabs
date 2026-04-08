"use client";

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
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo } from "react";
import { ConfigurationSheetWrapper } from "./configuration-sheet-wrapper";
import { VineNode } from "./nodes/vine-node";

interface VineyardEstateMapProps {
	vineyard: any;
}

const nodeTypes: NodeTypes = {
	vineNode: VineNode,
};

export function VineyardEstateMap({ vineyard }: VineyardEstateMapProps) {
	const router = useRouter();
	const pathname = usePathname();
	const searchParams = useSearchParams();

	// Create initial nodes from configurations
	const initialNodes = useMemo(() => {
		return (vineyard.configurations || []).map(
			(config: any, index: number) => ({
				id: `vine-${config.id}`,
				type: "vineNode",
				position: {
					x: config.ui_position_x || 250 + index * 300,
					y: config.ui_position_y || 150 + index * 50,
				},
				data: {
					config,
					onClick: () => {
						const newSearchParams = new URLSearchParams(
							searchParams.toString(),
						);
						newSearchParams.set("config_id", config.id);
						router.replace(
							`${pathname}?${newSearchParams.toString()}`,
							{ scroll: false },
						);
					},
				},
			}),
		);
	}, [vineyard.configurations, router, pathname, searchParams]);

	// Create initial edges (empty for now unless we add harvests/tendrils)
	const initialEdges: Edge[] = [];

	const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
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

			{/* Render the details sheet for when a node is clicked */}
			<ConfigurationSheetWrapper
				configurations={vineyard.configurations || []}
			/>
		</div>
	);
}
