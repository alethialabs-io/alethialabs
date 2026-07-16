// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Containers — the structural fix that makes a large architecture read as an architecture.
//
// Flat, every node is a sibling: a managed database and an in-cluster Grafana float side by side as
// if they were the same kind of thing. They are not. A database lives IN the VPC but OUTSIDE the
// cluster; an add-on lives INSIDE the cluster; a bucket has no VPC at all. Drawing them as siblings
// is a lie about the system.
//
// So the board draws labeled regions — the VPC and, within it, the cluster, plus one region per BYO
// IaC module — and puts each resource where it actually runs.
//
// A container's geometry is DERIVED from its members (a padded bounding box) until the user drags or
// resizes it, at which point their chosen box is remembered as an OVERRIDE (session-only, never in
// the DB and never in the Deploy diff). Cards keep ABSOLUTE positions and are NOT React Flow children
// of the container: dragging a container translates its members in absolute space; resizing only
// changes the container's own box and can never clip a card. The stored data model is untouched.

import type { CanvasNode, NodeKind } from "@/components/design-project/canvas/graph/types";
import type { CloudProviderSlug } from "@/lib/cloud-providers";
import { collectionNodeId, isCollectionKind, type BoardNode } from "./collections";

/** Where a resource actually runs. */
export type ZoneId = "cluster" | "network";

/** The single container that holds a whole bring-your-own IaC module's resources. */
export const EXTERNAL_CONTAINER_ID = "external:module";

/** Padding between a container's border and the nodes it encloses. */
const PAD = { x: 18, top: 40, bottom: 18 } as const;
/** A card's footprint. The container maths only needs an upper bound, not the exact rendered size. */
const CARD = { w: 248, h: 132 } as const;

/**
 * Which zone a kind belongs to.
 *
 * `network` (the VPC) holds the cluster and every managed data service. `cluster` holds what runs as
 * workloads inside Kubernetes. Periphery kinds — DNS, buckets, registry, secrets, GitOps — have no
 * VPC and are deliberately absent: they sit outside both regions, which is exactly the placement
 * rule the code already enforces (they're the kinds allowed to diverge to another cloud).
 */
const ZONE_OF_KIND: Partial<Record<NodeKind, ZoneId>> = {
	// The network card is the VPC's own anchor; the cluster card anchors the cluster region.
	network: "network",
	cluster: "cluster",
	// Managed data services live in the VPC, but outside Kubernetes.
	database: "network",
	cache: "network",
	queue: "network",
	topic: "network",
	nosql: "network",
	// BYO Helm charts and marketplace add-ons are Kubernetes workloads — they run in the cluster.
	chart: "cluster",
	addon: "cluster",
};

/**
 * The zone a node belongs to, given the effective cloud.
 *
 * On a compute-only cloud (Hetzner) there is no managed data plane: a database is a CloudNativePG
 * cluster, a cache is Valkey, a queue is RabbitMQ — all Helm charts running INSIDE Kubernetes. So on
 * that cloud those kinds move into the cluster zone, and the picture finally matches what actually
 * gets deployed. This is the same honesty the card's facts already carry ("Runs as · CloudNativePG").
 */
export function zoneForNode(
	kind: NodeKind,
	provider: CloudProviderSlug | null,
): ZoneId | null {
	if (provider === "hetzner" && (kind === "database" || kind === "cache" || kind === "queue")) {
		return "cluster";
	}
	return ZONE_OF_KIND[kind] ?? null;
}

export interface ZoneNodeData extends Record<string, unknown> {
	zone: ZoneId | "external";
	/** Nesting depth — the cluster sits inside the network. Drives the z-order. */
	depth: number;
	memberCount: number;
	/** The derived (auto-fit) size, so the resizer's minimum never clips the members. */
	minWidth: number;
	minHeight: number;
	/** True when the user has dragged/resized this container (a geometry override exists). */
	pinned: boolean;
}

/** A resizable, draggable container region. Its members are painted on top (higher z-index). */
export type ContainerNode = {
	id: string;
	type: "zone";
	position: { x: number; y: number };
	data: ZoneNodeData;
	width: number;
	height: number;
	draggable: true;
	selectable: true;
	deletable: false;
	/** Controlled selection — drives the resize handles' visibility. */
	selected?: boolean;
	/** Only the header initiates a drag; the body stays click-through so the pane can pan. */
	dragHandle: string;
	/** Behind every card. React Flow paints ascending. */
	zIndex: number;
};

/** A user-overridden container box (position + size). Absent = derive from members. */
export interface ContainerBox {
	x: number;
	y: number;
	width: number;
	height: number;
}
/** Per-container geometry overrides, keyed by container id. Session-only; never DB, never diffed. */
export type ContainerGeometry = Record<string, ContainerBox>;

export const zoneNodeId = (zone: ZoneId) => `zone:${zone}`;

/** True for a synthetic zone id (the VPC / cluster regions). */
export const isZoneId = (id: string) => id.startsWith("zone:");

/** True for ANY container id — a zone OR a BYO-module region. These have no store row. */
export const isContainerId = (id: string) =>
	id.startsWith("zone:") || id.startsWith("external:");

/** The drag handle class the container header carries (React Flow's `dragHandle` selector). */
export const CONTAINER_DRAG_HANDLE = "zone-drag-handle";

interface Box {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** The bounding box of a set of positioned cards, padded out to a container. */
function boundsOf(nodes: { position: { x: number; y: number } }[], inset: number): Box {
	const xs = nodes.map((n) => n.position.x);
	const ys = nodes.map((n) => n.position.y);
	const minX = Math.min(...xs);
	const minY = Math.min(...ys);
	const maxX = Math.max(...xs) + CARD.w;
	const maxY = Math.max(...ys) + CARD.h;
	return {
		x: minX - PAD.x - inset,
		y: minY - PAD.top - inset,
		width: maxX - minX + PAD.x * 2 + inset * 2,
		height: maxY - minY + PAD.top + PAD.bottom + inset * 2,
	};
}

/**
 * The DERIVED (auto-fit) box per container, before any user override is applied.
 *
 * The cluster's box is computed first, then the network's box is grown to CONTAIN it — so the VPC
 * always visibly encloses the cluster even when the cluster's members are laid out beyond the data
 * services. A container with no members has no entry. Exported so the flow can read a container's
 * live auto-fit bounds (for the resizer's minimum) without recomputing.
 */
export function containerDerivedBoxes(
	nodes: BoardNode[],
	containerOf: (node: BoardNode) => string | null,
): Map<string, Box> {
	const byContainer = new Map<string, BoardNode[]>();
	for (const node of nodes) {
		const id = containerOf(node);
		if (!id) continue;
		const list = byContainer.get(id);
		if (list) list.push(node);
		else byContainer.set(id, [node]);
	}

	const boxes = new Map<string, Box>();

	const clusterMembers = byContainer.get(zoneNodeId("cluster")) ?? [];
	const clusterBox = clusterMembers.length ? boundsOf(clusterMembers, 0) : null;
	if (clusterBox) boxes.set(zoneNodeId("cluster"), clusterBox);

	// The network encloses its own members AND the whole cluster region.
	const networkMembers = byContainer.get(zoneNodeId("network")) ?? [];
	if (networkMembers.length || clusterBox) {
		const base = networkMembers.length ? boundsOf(networkMembers, 12) : null;
		const box = mergeBoxes(base, clusterBox ? padBox(clusterBox, 14) : null);
		if (box) boxes.set(zoneNodeId("network"), box);
	}

	// The BYO module region — one box around every external card.
	const externalMembers = byContainer.get(EXTERNAL_CONTAINER_ID) ?? [];
	if (externalMembers.length) {
		boxes.set(EXTERNAL_CONTAINER_ID, boundsOf(externalMembers, 8));
	}

	return boxes;
}

/** Depth (z-order) per container: the cluster nests above the VPC; the module sits at the base. */
const CONTAINER_DEPTH: Record<string, number> = {
	[zoneNodeId("network")]: 0,
	[zoneNodeId("cluster")]: 1,
	[EXTERNAL_CONTAINER_ID]: 0,
};
const CONTAINER_ZINDEX: Record<string, number> = {
	[zoneNodeId("network")]: -2,
	[zoneNodeId("cluster")]: -1,
	[EXTERNAL_CONTAINER_ID]: -2,
};
const CONTAINER_ZONE: Record<string, ZoneId | "external"> = {
	[zoneNodeId("network")]: "network",
	[zoneNodeId("cluster")]: "cluster",
	[EXTERNAL_CONTAINER_ID]: "external",
};

/**
 * The container regions for a board: derived boxes overridden by any user-set geometry.
 *
 * A container is drawn only when it has at least one visible member — even if a stale override
 * exists — so hiding a kind shrinks its region and hiding them all removes it. The override is
 * harmless while empty and re-applies when the members return.
 */
export function buildContainers(
	nodes: BoardNode[],
	containerOf: (node: BoardNode) => string | null,
	geometry: ContainerGeometry,
): ContainerNode[] {
	const counts = new Map<string, number>();
	for (const node of nodes) {
		const id = containerOf(node);
		if (!id) continue;
		counts.set(id, (counts.get(id) ?? 0) + 1);
	}

	const derived = containerDerivedBoxes(nodes, containerOf);
	const containers: ContainerNode[] = [];

	// Emit in z-order (network behind cluster) so React Flow's ascending paint keeps nesting readable.
	const order = [zoneNodeId("network"), zoneNodeId("cluster"), EXTERNAL_CONTAINER_ID];
	for (const id of order) {
		const memberCount = counts.get(id) ?? 0;
		if (memberCount === 0) continue;
		const auto = derived.get(id);
		if (!auto) continue;
		const override = geometry[id];
		const box = override ?? auto;
		containers.push({
			id,
			type: "zone",
			position: { x: box.x, y: box.y },
			width: box.width,
			height: box.height,
			data: {
				zone: CONTAINER_ZONE[id],
				depth: CONTAINER_DEPTH[id],
				memberCount,
				minWidth: auto.width,
				minHeight: auto.height,
				pinned: !!override,
			},
			draggable: true,
			selectable: true,
			deletable: false,
			dragHandle: `.${CONTAINER_DRAG_HANDLE}`,
			zIndex: CONTAINER_ZINDEX[id],
		});
	}

	return containers;
}

/** The smallest box containing both (either may be absent). */
function mergeBoxes(a: Box | null, b: Box | null): Box | null {
	if (!a) return b;
	if (!b) return a;
	const x = Math.min(a.x, b.x);
	const y = Math.min(a.y, b.y);
	const right = Math.max(a.x + a.width, b.x + b.width);
	const bottom = Math.max(a.y + a.height, b.y + b.height);
	return { x, y, width: right - x, height: bottom - y };
}

function padBox(box: Box, by: number): Box {
	return {
		x: box.x - by,
		y: box.y - by,
		width: box.width + by * 2,
		height: box.height + by * 2,
	};
}

/**
 * The zone of a board node — the VPC/cluster membership used by the LAYOUT and the card's own logic.
 *
 * Collection cards (the Secrets vault) resolve through their KIND, so a vault of in-cluster resources
 * would land in the cluster — today secrets are periphery, so it sits outside both regions, which is
 * correct.
 *
 * An EXTERNAL card resolves through the kind its resources MAP to — which is what lets its CARD wear
 * the mapped kind's face (a customer module's `aws_eks_*` group says CLUSTER). Note this is the
 * card's *face*, not its container: `containerOfBoardNode` puts every external card in the one module
 * region regardless of what it maps to.
 */
export function zoneOfBoardNode(
	node: BoardNode,
	providerOf: (kind: NodeKind) => CloudProviderSlug | null,
): ZoneId | null {
	const data = node.data as { kind: NodeKind; config?: { mappedKind?: NodeKind | null } };
	if (data.kind === "external") {
		const mapped = data.config?.mappedKind ?? null;
		return mapped ? zoneForNode(mapped, providerOf(mapped)) : null;
	}
	const kind = data.kind;
	return zoneForNode(kind, providerOf(kind));
}

/**
 * The CONTAINER a board node belongs to (its `parentId`-equivalent — one owner per card).
 *
 * Every `external` card belongs to the single BYO-module region (the whole-module decision), so they
 * no longer distribute into the VPC/cluster (which would double-count them and overlap the boxes).
 * Every other card resolves through its zone: cluster → the cluster region, network → the VPC,
 * periphery → no container.
 */
export function containerOfBoardNode(
	node: BoardNode,
	providerOf: (kind: NodeKind) => CloudProviderSlug | null,
): string | null {
	if ((node.data as { kind: NodeKind }).kind === "external") return EXTERNAL_CONTAINER_ID;
	const zone = zoneOfBoardNode(node, providerOf);
	return zone ? zoneNodeId(zone) : null;
}

/**
 * The store-node ids that move when a container is dragged. Nesting-aware: dragging the VPC carries
 * its own members AND the cluster's; dragging the cluster carries only cluster members; the module
 * region carries its external cards. Returns a de-duplicated list so a nested card never moves twice.
 */
export function dragMemberIds(
	nodes: BoardNode[],
	containerId: string,
	containerOf: (node: BoardNode) => string | null,
): string[] {
	const owned: string[] = [];
	const ids = new Set<string>();
	const take = (node: BoardNode) => {
		if (!ids.has(node.id)) {
			ids.add(node.id);
			owned.push(node.id);
		}
	};
	for (const node of nodes) {
		const c = containerOf(node);
		if (c === containerId) take(node);
		// The VPC also carries the cluster nested inside it.
		else if (containerId === zoneNodeId("network") && c === zoneNodeId("cluster")) take(node);
	}
	return owned;
}

/** The id a zone-aware layout should use for a kind's card (a collection collapses to one). */
export function cardIdForKind(kind: NodeKind, nodeId: string): string {
	return isCollectionKind(kind) ? collectionNodeId(kind) : nodeId;
}

/** A card's footprint, for layout callers. */
export const CARD_SIZE = CARD;

/** Re-exported so the layout and the flow agree on padding. */
export const ZONE_PADDING = PAD;

export type { CanvasNode };
