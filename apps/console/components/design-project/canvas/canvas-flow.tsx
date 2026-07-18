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
import { useMemo, useState } from "react";
import {
	buildRenderNodes,
	collectionNodeId,
	isCollectionKind,
	kindFromCollectionId,
	type BoardNode,
} from "@/lib/canvas/collections";
import {
	buildContainers,
	containerOfBoardNode,
	dragMemberIds,
	isContainerId,
	zoneNodeId,
	type ContainerBox,
	type ContainerNode,
} from "@/lib/canvas/zones";
import { useEnvironmentStatus } from "@/lib/canvas/environment-status-context";
import { OUT_OF_BAND, useCanvasStore } from "@/lib/stores/use-canvas-store";
import type { CanvasNode, NodeKind } from "./graph/types";
import { NODE_REGISTRY } from "./graph/node-registry";
import { ChartNode } from "./nodes/chart-node";
import { CollectionNode } from "./nodes/collection-node";
import { ServiceNode } from "./nodes/service-node";
import { ZoneNode as ZoneNodeComponent } from "./nodes/zone-node";
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
	// The VPC / cluster regions. Also synthetic: derived bounding boxes, painted behind the cards.
	zone: ZoneNodeComponent,
};

const edgeTypes: EdgeTypes = {
	dependency: DependencyEdge,
	gated: GatedEdge,
	// W3 — a service's dotted "consumes" edge to a backing resource it binds to.
	binding: BindingEdge,
	// W5 Path A — a described chart workload's dotted binding edge to a backing resource.
	cw_binding: ChartBindingEdge,
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
	const containerGeometry = useCanvasStore((s) => s.containerGeometry);
	const setContainerGeometry = useCanvasStore((s) => s.setContainerGeometry);
	const translateContainer = useCanvasStore((s) => s.translateContainer);

	// Which container's resize handles are showing. Controlled here (containers are synthetic — they
	// have no store row), set on click and cleared when a card or the pane is clicked.
	const [selectedContainerId, setSelectedContainerId] = useState<string | null>(null);

	// When a bring-your-own IaC module governs this environment it REPLACES the template (v1 replace
	// mode), so the component design is INERT — it will never be applied. Left on the board it reads
	// "Not deployed" forever beside the module's real resources: two clusters, one of which does not
	// exist in the customer's cloud. So it isn't drawn. Charts and add-ons stay — those are real
	// ArgoCD workloads on the cluster, whatever provisioned it.
	//
	// The design is HIDDEN, not deleted: the store still holds it, so detaching the source brings it
	// straight back. (The old surface made the same point by dimming the whole graph behind an
	// overlay — the point was right; the execution buried the architecture.)
	const iacGoverned = useEnvironmentStatus().iac !== null;

	// Visibility layers hide whole node groups; connections toggle hides all edges.
	// Edges to/from a hidden node are dropped so none dangle. The project root is the graph's
	// data anchor (name/region/core identity) but is never drawn — it's edited via the toolbar's
	// Project settings button instead.
	const designNodes = nodes.filter(
		(n) =>
			n.data.kind !== "project" &&
			!hiddenKinds.includes(n.data.kind) &&
			!(iacGoverned && !OUT_OF_BAND.has(n.data.kind)),
	);

	// High-cardinality kinds (secrets) collapse into ONE card. This is a VIEW transform only — the
	// store keeps a node per resource, so the diff / status / persistence machinery is untouched.
	const cards = useMemo(
		() => buildRenderNodes(designNodes, collectionPositions),
		[designNodes, collectionPositions],
	);

	// The container a board node belongs to (its parentId-equivalent — one owner per card): every
	// external card to the one BYO-module region, everything else to its VPC/cluster zone, periphery to
	// none. This is the single seam through which membership stays a pure function of kind/provider.
	const containerOf = useMemo(
		() =>
			(node: BoardNode) =>
				containerOfBoardNode(node, (kind) => providerOfKind(nodes, kind)),
		[nodes],
	);

	// The VPC / cluster / BYO-module regions. Geometry derives from where the member cards sit until
	// the user drags or resizes a region, at which point their box is remembered as an override.
	// Painted BEHIND the cards (negative zIndex); a card in front of its own region is the whole point.
	// Hiding a kind shrinks its region; hiding them all removes it (a region with no members isn't drawn
	// even if a stale override exists).
	const containers = useMemo(
		() => buildContainers(cards, containerOf, containerGeometry),
		[cards, containerOf, containerGeometry],
	);

	// Controlled selection drives the resize handles. Kept off the memo above so toggling selection
	// doesn't rebuild every container box.
	const containersWithSelection = useMemo<ContainerNode[]>(
		() =>
			containers.map((c) =>
				c.id === selectedContainerId ? { ...c, selected: true } : c,
			),
		[containers, selectedContainerId],
	);

	// A card drawn inside a container renders the dense treatment. Flag it on the RENDER node only —
	// a shallow clone, never the store node — using the same pure membership function the containers
	// use. Collections (periphery) resolve to no container, so they're never flagged.
	const denseCards = useMemo(
		() =>
			cards.map((card) => {
				if (!("config" in card.data) || !containerOf(card)) return card;
				return { ...card, data: { ...card.data, insideContainer: true } };
			}),
		[cards, containerOf],
	);

	const visibleNodes = useMemo<(BoardNode | ContainerNode)[]>(
		() => [...containersWithSelection, ...denseCards],
		[containersWithSelection, denseCards],
	);

	// A collapsed member has no card of its own, so an edge pointing at it would dangle. Re-target
	// those edges at the collection card and drop the duplicates the collapse creates.
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

	// A container's current rendered box, by id — the reference the drag/resize handlers read.
	const containerById = useMemo(
		() => new Map(containers.map((c) => [c.id, c])),
		[containers],
	);

	return (
		<ReactFlow<BoardNode | ContainerNode>
			nodes={visibleNodes}
			edges={visibleEdges}
			onNodesChange={(changes) => {
				// Collections and containers have NO row in the store, so their changes must never reach
				// applyNodeChanges — it would try to patch a node that doesn't exist. Peel them off: a
				// collection drag becomes its own persisted position; a container drag translates its
				// members (absolute), a container resize writes its geometry override, and nothing about a
				// container ever moves a member on resize. Everything left is a real store node. All the
				// synthetics are `deletable: false`, so a stray Backspace can't wipe forty secrets or a
				// whole region either.
				const passthrough: NodeChange<CanvasNode>[] = [];
				// A top-left resize sends BOTH a dimensions and a position change for the same container in
				// one batch. The presence of a dimensions change is the resize discriminator — so a resize
				// never translates members. Accumulate the resulting geometry and apply it after the loop.
				const resizing = new Set<string>();
				for (const c of changes) {
					if (c.type === "dimensions" && "id" in c && isContainerId(c.id)) {
						resizing.add(c.id);
					}
				}
				const resizeGeom = new Map<string, Partial<ContainerBox>>();
				for (const change of changes) {
					const id = "id" in change ? change.id : null;
					if (id && isContainerId(id)) {
						if (resizing.has(id)) {
							const cur = resizeGeom.get(id) ?? {};
							if (change.type === "dimensions" && change.dimensions) {
								resizeGeom.set(id, {
									...cur,
									width: change.dimensions.width,
									height: change.dimensions.height,
								});
							} else if (change.type === "position" && change.position) {
								resizeGeom.set(id, { ...cur, x: change.position.x, y: change.position.y });
							}
						} else if (change.type === "position" && change.position) {
							// DRAG: shift every member (nested-aware) by the delta, and pin the dragged
							// container (+ any pinned nested cluster) so it tracks the cursor.
							const box = containerById.get(id);
							if (box) {
								const delta = {
									x: change.position.x - box.position.x,
									y: change.position.y - box.position.y,
								};
								const memberIds = dragMemberIds(designNodes, id, containerOf);
								const pins: { id: string; box: ContainerBox }[] = [
									{
										id,
										box: {
											x: box.position.x,
											y: box.position.y,
											width: box.width,
											height: box.height,
										},
									},
								];
								// A DERIVED cluster follows its members for free; a PINNED one must be carried.
								const clusterId = zoneNodeId("cluster");
								if (id === zoneNodeId("network") && containerGeometry[clusterId]) {
									pins.push({ id: clusterId, box: containerGeometry[clusterId] });
								}
								translateContainer(delta, { memberIds, pins });
							}
						}
						// select / remove / other container changes have no store effect.
						continue;
					}
					const kind = id ? kindFromCollectionId(id) : null;
					if (kind) {
						if (change.type === "position" && change.position) {
							setCollectionPosition(kind, change.position);
						}
						continue;
					}
					// Everything left refers to a real store node. React Flow types the change against
					// the board's union; narrowing it back is sound precisely because the synthetic ids —
					// the only source of container/collection changes — were just filtered out.
					// eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- synthetic container/collection ids were filtered out above, so this change refers to a real CanvasNode; react-flow can't express that runtime narrowing
					passthrough.push(change as NodeChange<CanvasNode>);
				}
				for (const [id, partial] of resizeGeom) {
					const box = containerById.get(id);
					if (!box) continue;
					setContainerGeometry(id, {
						x: partial.x ?? box.position.x,
						y: partial.y ?? box.position.y,
						width: partial.width ?? box.width,
						height: partial.height ?? box.height,
					});
				}
				if (passthrough.length) onNodesChange(passthrough);
			}}
			nodeTypes={nodeTypes}
			edgeTypes={edgeTypes}
			onNodeClick={(_, node) => {
				// Clicking a region selects it (revealing its resize handles) but never opens an
				// inspector — it isn't a resource. Clicking a card clears the region selection.
				if (isContainerId(node.id)) {
					setSelectedContainerId(node.id);
				} else {
					setSelectedContainerId(null);
					openInspector(node.id);
				}
			}}
			onPaneClick={() => {
				setSelectedContainerId(null);
				openInspector(null);
			}}
			deleteKeyCode={["Backspace", "Delete"]}
			fitView
			fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
			minZoom={0.2}
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
			{/* A forty-node board needs a way to know where you are. Grayscale, like everything else. */}
			<MiniMap
				pannable
				zoomable
				ariaLabel="Architecture minimap"
				className="!border !border-border !bg-card"
				maskColor="var(--surface-sunken)"
				nodeColor="var(--border-strong)"
				nodeStrokeColor="var(--border-strong)"
				nodeClassName={(n) => (isContainerId(n.id) ? "opacity-30" : "")}
			/>
		</ReactFlow>
	);
}

/** The effective cloud for a kind — a node's own identity, else the project's. */
function providerOfKind(nodes: CanvasNode[], kind: NodeKind) {
	const own = nodes.find((n) => n.data.kind === kind)?.data.provider;
	if (own) return own;
	return nodes.find((n) => n.data.kind === "project")?.data.provider ?? null;
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
