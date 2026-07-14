// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Zones — the structural fix that makes a large architecture read as an architecture.
//
// Flat, every node is a sibling: a managed database and an in-cluster Grafana float side by side as
// if they were the same kind of thing. They are not. A database lives IN the VPC but OUTSIDE the
// cluster; an add-on lives INSIDE the cluster; a bucket has no VPC at all. Drawing them as siblings
// is a lie about the system.
//
// So the board draws two nested regions — the VPC and, within it, the cluster — and puts each
// resource where it actually runs.
//
// Like collections, a zone is DERIVED: a bounding box computed from its members, not a React Flow
// parent. That means no parentId, no relative coordinates, and no change to how positions are stored
// — dragging a node simply re-bounds the zone around it. The model stays exactly as it was.

import type { CanvasNode, NodeKind } from "@/components/design-project/canvas/graph/types";
import type { CloudProviderSlug } from "@/lib/cloud-providers";
import { collectionNodeId, isCollectionKind, type BoardNode } from "./collections";

/** Where a resource actually runs. */
export type ZoneId = "cluster" | "network";

/** Padding between a zone's border and the nodes it encloses. */
const PAD = { x: 18, top: 40, bottom: 18 } as const;
/** A card's footprint. The zone maths only needs an upper bound, not the exact rendered size. */
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
	zone: ZoneId;
	/** Nesting depth — the cluster sits inside the network. Drives the z-order. */
	depth: number;
	memberCount: number;
}

/** A zone is a background region, never an interactive node. */
export type ZoneNode = {
	id: string;
	type: "zone";
	position: { x: number; y: number };
	data: ZoneNodeData;
	width: number;
	height: number;
	draggable: false;
	selectable: false;
	deletable: false;
	/** Behind every card. React Flow paints ascending. */
	zIndex: number;
};

export const zoneNodeId = (zone: ZoneId) => `zone:${zone}`;

/** True for a synthetic zone id — these have no store row and must never reach the store. */
export const isZoneId = (id: string) => id.startsWith("zone:");

interface Box {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** The bounding box of a set of positioned cards, padded out to a zone. */
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
 * The zone regions for a board, derived from where its cards are.
 *
 * The cluster's box is computed first, then the network's box is grown to CONTAIN it — so the VPC
 * always visibly encloses the cluster even when the cluster's members are laid out beyond the data
 * services. A zone with no members isn't drawn at all.
 */
export function buildZones(
	nodes: BoardNode[],
	zoneOf: (node: BoardNode) => ZoneId | null,
): ZoneNode[] {
	const byZone = new Map<ZoneId, BoardNode[]>();
	for (const node of nodes) {
		const zone = zoneOf(node);
		if (!zone) continue;
		const list = byZone.get(zone);
		if (list) list.push(node);
		else byZone.set(zone, [node]);
	}

	const zones: ZoneNode[] = [];

	const clusterMembers = byZone.get("cluster") ?? [];
	const clusterBox = clusterMembers.length ? boundsOf(clusterMembers, 0) : null;

	// The network encloses its own members AND the whole cluster region.
	const networkMembers = byZone.get("network") ?? [];
	if (networkMembers.length || clusterBox) {
		const base = networkMembers.length ? boundsOf(networkMembers, 12) : null;
		const box = mergeBoxes(base, clusterBox ? padBox(clusterBox, 14) : null);
		if (box) {
			zones.push({
				id: zoneNodeId("network"),
				type: "zone",
				position: { x: box.x, y: box.y },
				width: box.width,
				height: box.height,
				data: { zone: "network", depth: 0, memberCount: networkMembers.length },
				draggable: false,
				selectable: false,
				deletable: false,
				zIndex: -2,
			});
		}
	}

	if (clusterBox) {
		zones.push({
			id: zoneNodeId("cluster"),
			type: "zone",
			position: { x: clusterBox.x, y: clusterBox.y },
			width: clusterBox.width,
			height: clusterBox.height,
			data: { zone: "cluster", depth: 1, memberCount: clusterMembers.length },
			draggable: false,
			selectable: false,
			deletable: false,
			zIndex: -1,
		});
	}

	return zones;
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
 * The zone of a board node. Collection cards (the Secrets vault) resolve through their KIND, so a
 * vault of in-cluster resources would land in the cluster — today secrets are periphery, so it sits
 * outside both regions, which is correct.
 */
export function zoneOfBoardNode(
	node: BoardNode,
	providerOf: (kind: NodeKind) => CloudProviderSlug | null,
): ZoneId | null {
	const kind =
		node.type === "collection"
			? (node.data as { kind: NodeKind }).kind
			: ((node.data as { kind: NodeKind }).kind as NodeKind);
	return zoneForNode(kind, providerOf(kind));
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
