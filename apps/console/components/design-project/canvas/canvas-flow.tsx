"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import {
	Background,
	BackgroundVariant,
	MiniMap,
	ReactFlow,
	type EdgeTypes,
	type NodeChange,
	type NodeTypes,
} from "@xyflow/react";
import { typedKeys } from "@/lib/typed-object";
import "@xyflow/react/dist/style.css";
import { cn } from "@repo/ui/utils";
import { createContext, useContext, useMemo } from "react";
import {
	buildRenderNodes,
	collectionNodeId,
	isCollectionKind,
	kindFromCollectionId,
	type BoardNode,
} from "@/lib/canvas/collections";
import { useEnvironmentStatus } from "@/lib/canvas/environment-status-context";
import { OUT_OF_BAND, useCanvasStore } from "@/lib/stores/use-canvas-store";
import type { CanvasNode } from "./graph/types";
import { NODE_REGISTRY } from "./graph/node-registry";
import { ChartNode } from "./nodes/chart-node";
import { CollectionNode } from "./nodes/collection-node";
import { ServiceNode } from "./nodes/service-node";
import { BindingEdge } from "./edges/binding-edge";
import { ChartBindingEdge } from "./edges/chart-binding-edge";
import { DependencyEdge } from "./edges/dependency-edge";
import { GatedEdge } from "./edges/gated-edge";

// Every registry kind renders through the ONE data-driven card (ServiceNode → BaseNode), which
// reads its facts + handles from NODE_REGISTRY — so a new kind is picked up here automatically and
// this map can't drift from the SSOT. `chart` keeps its own component: BYO charts are persisted
// out-of-band and carry detach / rescan actions, so they're more than a card.
// Defined at module scope so React Flow doesn't warn about new objects per render.
const nodeTypes: NodeTypes = {
	...Object.fromEntries(
		typedKeys(NODE_REGISTRY).map((kind) => [kind, ServiceNode]),
	),
	chart: ChartNode,
	// The collapsed card for a high-cardinality kind (the Secrets vault). Synthetic — it has no
	// store row; `buildRenderNodes` creates it from the members.
	collection: CollectionNode,
};

const edgeTypes: EdgeTypes = {
	dependency: DependencyEdge,
	gated: GatedEdge,
	// W3 — a service's dotted "consumes" edge to a backing resource it binds to.
	binding: BindingEdge,
	// W5 Path A — a described chart workload's dotted binding edge to a backing resource.
	cw_binding: ChartBindingEdge,
};

/**
 * Canvas traversal mode (Excalidraw/Miro model). `handTool` is the toolbar/`H` hand tool (a sticky
 * pan mode); `spaceHeld` is the transient Space-to-pan. Either makes left-drag pan the pane and
 * shows a grab cursor; otherwise left-drag marquee-selects. Provided by `DesignProjectCanvas`
 * (which owns the state + the keyboard listeners) and consumed by the board + the controls — the
 * canvas store is deliberately not touched (this is view interaction, not design state).
 */
export interface CanvasInteraction {
	handTool: boolean;
	setHandTool: (next: boolean) => void;
	spaceHeld: boolean;
}
export const CanvasInteractionContext = createContext<CanvasInteraction>({
	handTool: false,
	setHandTool: () => {},
	spaceHeld: false,
});

/**
 * The React Flow surface, controlled by the canvas store.
 *
 * W2 — the board is a flat graph of workloads + backing infra. It draws NO region frames: one
 * environment IS one cluster (inside one VPC), so the cluster/network aren't drawn as containers or
 * cards — they're env settings (the toolbar "Cluster & network" sheet). This retired the whole
 * zone/container machinery (`lib/canvas/zones.ts`): the old VPC/cluster regions existed only to
 * explain a substrate that is now implicit. Edges are the derived service→resource bindings (the
 * cluster→leaf dependency spine went with the cluster node).
 */
export function CanvasFlow() {
	const nodes = useCanvasStore((s) => s.nodes);
	const edges = useCanvasStore((s) => s.edges);
	const onNodesChange = useCanvasStore((s) => s.onNodesChange);
	const openInspector = useCanvasStore((s) => s.openInspector);
	const showConnections = useCanvasStore((s) => s.showConnections);
	const hiddenKinds = useCanvasStore((s) => s.hiddenKinds);
	const collectionPositions = useCanvasStore((s) => s.collectionPositions);
	const setCollectionPosition = useCanvasStore((s) => s.setCollectionPosition);

	// Traversal mode: the hand tool or a held Space turns left-drag into a pan (Excalidraw/Miro);
	// otherwise left-drag marquee-selects. Middle/right mouse always pan.
	const { handTool, spaceHeld } = useContext(CanvasInteractionContext);
	const panning = handTool || spaceHeld;

	// When a bring-your-own IaC module governs this environment it REPLACES the template (v1 replace
	// mode), so the component design is INERT — it will never be applied. It's HIDDEN, not deleted:
	// the store still holds it, so detaching the source brings it straight back.
	const iacGoverned = useEnvironmentStatus().iac !== null;

	// Visibility layers hide whole node groups; connections toggle hides all edges. The project root
	// (data anchor: name/region/core identity) and the cluster + network (env-level substrate, edited
	// as settings) are never drawn — they persist as hidden store nodes so graphToForm/the deploy
	// snapshot are byte-identical. Edges to/from a hidden node are dropped so none dangle.
	const designNodes = nodes.filter(
		(n) =>
			n.data.kind !== "project" &&
			n.data.kind !== "cluster" &&
			n.data.kind !== "network" &&
			!hiddenKinds.includes(n.data.kind) &&
			!(iacGoverned && !OUT_OF_BAND.has(n.data.kind)),
	);

	// High-cardinality kinds (secrets) collapse into ONE card. This is a VIEW transform only — the
	// store keeps a node per resource, so the diff / status / persistence machinery is untouched.
	const cards = useMemo(
		() => buildRenderNodes(designNodes, collectionPositions),
		[designNodes, collectionPositions],
	);

	// A collapsed member has no card of its own, so an edge pointing at it would dangle. Re-target
	// those edges at the collection card and drop the duplicates the collapse creates. Edges whose
	// endpoint is a hidden node (project / cluster / network) are dropped here too.
	const cardIds = new Set(cards.map((n) => n.id));
	const visibleEdges = showConnections
		? dedupeEdges(
				edges
					.map((e) => ({
						...e,
						source: renderTargetFor(e.source, nodes),
						target: renderTargetFor(e.target, nodes),
					}))
					.filter((e) => cardIds.has(e.source) && cardIds.has(e.target)),
			)
		: [];

	return (
		<ReactFlow<BoardNode>
			nodes={cards}
			edges={visibleEdges}
			onNodesChange={(changes) => {
				// A collection card (the Secrets vault) has NO row in the store, so its change must never
				// reach applyNodeChanges. Peel it off (its drag becomes a persisted collection position);
				// everything left refers to a real store node.
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
					// React Flow types the change against the board node union; narrowing it back to a real
					// CanvasNode is sound because the only synthetic id (a collection) was just filtered out.
					// @ts-expect-error collection ids were filtered out above, so this change refers to a real CanvasNode; react-flow can't express that runtime narrowing
					passthrough.push(change);
				}
				if (passthrough.length) onNodesChange(passthrough);
			}}
			nodeTypes={nodeTypes}
			edgeTypes={edgeTypes}
			onNodeClick={(_, node) => openInspector(node.id)}
			onPaneClick={() => openInspector(null)}
			deleteKeyCode={["Backspace", "Delete"]}
			// ── Excalidraw/Miro traversal ─────────────────────────────────────────────────────────
			// Left-drag marquee-selects (better click-state handling); Space or the hand tool turns
			// left-drag into a pan. Middle + right mouse always pan. Scroll pans (trackpad-native);
			// Ctrl/⌘+scroll and pinch zoom. This replaces the stock default where left-drag panned and
			// there was no discoverable select.
			panOnDrag={panning ? true : [1, 2]}
			selectionOnDrag={!panning}
			panActivationKeyCode="Space"
			panOnScroll
			zoomOnScroll={false}
			zoomOnPinch
			fitView
			fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
			minZoom={0.2}
			maxZoom={1.5}
			proOptions={{ hideAttribution: true }}
			className={cn("bg-background", panning && "cursor-grab active:cursor-grabbing")}
		>
			<Background
				variant={BackgroundVariant.Dots}
				gap={16}
				size={1}
				color="var(--border, #e5e5e5)"
			/>
			{/* A forty-node board needs a way to know where you are. Grayscale, like everything else. */}
			<MiniMap
				pannable
				zoomable
				ariaLabel="Architecture minimap"
				className="!border !border-border !bg-card"
				maskColor="var(--surface-sunken)"
				nodeColor="var(--border-strong)"
				nodeStrokeColor="var(--border-strong)"
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
