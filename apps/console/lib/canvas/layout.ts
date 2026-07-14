// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Zone-aware layout. The old layout put every kind in its own row of a flat grid, which is why the
// board never read as an architecture — a managed database and an in-cluster Grafana sat side by
// side as if they were the same kind of thing.
//
// This one lays the board out the way the system is actually shaped:
//
//     ┌─ VPC ─────────────────────────────────┐   ┌ periphery ┐
//     │  [network]                            │   │  [dns]    │
//     │  ┌─ cluster ──────┐   [database]      │   │  [bucket] │
//     │  │ [cluster]      │   [cache]         │   │  [secrets]│
//     │  │ [chart] [chart]│   [queue]         │   │  [gitops] │
//     │  └────────────────┘                   │   └───────────┘
//     └───────────────────────────────────────┘
//
// Periphery kinds (DNS, buckets, registry, secrets, GitOps) sit OUTSIDE the VPC because that's the
// real rule — they're the kinds allowed to diverge to a different cloud entirely.
//
// Deterministic: same graph in, same board out. No layout engine, no async pass, no new dependency.

import type { CanvasNode, NodeKind } from "@/components/design-project/canvas/graph/types";
import type { CloudProviderSlug } from "@/lib/cloud-providers";
import { zoneForNode } from "./zones";

const CARD_W = 248;
const CARD_H = 132;
const GAP_X = 28;
const GAP_Y = 26;

/** In-cluster workloads wrap after this many columns. */
const CLUSTER_COLS = 2;
/** Managed data services wrap after this many columns. */
const DATA_COLS = 2;

const ORIGIN = { x: 80, y: 80 };
/** Space between the VPC region and the periphery column. */
const PERIPHERY_GAP = 120;

/** Where each node should sit. */
export type Layout = Map<string, { x: number; y: number }>;

/**
 * Lay the board out by zone. `providerOf` supplies each node's effective cloud, because on a
 * compute-only cloud the data services move INSIDE the cluster (they're Helm charts there) — so the
 * same design lays out differently, and correctly, per cloud.
 */
export function layoutZoned(
	nodes: CanvasNode[],
	providerOf: (nodeId: string) => CloudProviderSlug | null,
): Layout {
	const layout: Layout = new Map();

	const zoneOf = (n: CanvasNode) => zoneForNode(n.data.kind, providerOf(n.id));

	// The project root is the graph's data anchor and is never drawn.
	const drawable = nodes.filter((n) => n.data.kind !== "project");

	// The two zone anchors get placed first; everything else flows around them.
	const clusterCard = drawable.find((n) => n.data.kind === "cluster");
	const networkCard = drawable.find((n) => n.data.kind === "network");

	const inCluster = drawable.filter(
		(n) => zoneOf(n) === "cluster" && n.data.kind !== "cluster",
	);
	const inNetwork = drawable.filter(
		(n) => zoneOf(n) === "network" && n.data.kind !== "network",
	);
	const periphery = drawable.filter((n) => zoneOf(n) === null);

	// ── the cluster region ────────────────────────────────────────────────
	// The cluster card sits at the top of its own region, with its workloads beneath it.
	const clusterX = ORIGIN.x + 20;
	let clusterY = ORIGIN.y + (networkCard ? CARD_H + GAP_Y + 24 : 24);

	if (clusterCard) {
		layout.set(clusterCard.id, { x: clusterX, y: clusterY });
		clusterY += CARD_H + GAP_Y;
	}

	inCluster.forEach((node, i) => {
		const col = i % CLUSTER_COLS;
		const row = Math.floor(i / CLUSTER_COLS);
		layout.set(node.id, {
			x: clusterX + col * (CARD_W + GAP_X),
			y: clusterY + row * (CARD_H + GAP_Y),
		});
	});

	const clusterRows = Math.ceil(inCluster.length / CLUSTER_COLS);
	const clusterCols = Math.min(
		CLUSTER_COLS,
		Math.max(inCluster.length, clusterCard ? 1 : 0),
	);
	const clusterRight =
		clusterX + Math.max(clusterCols, 1) * (CARD_W + GAP_X) - GAP_X;
	const clusterBottom = clusterY + Math.max(clusterRows, 0) * (CARD_H + GAP_Y);

	// ── the VPC's own row: the network card, then the managed data services ─
	if (networkCard) layout.set(networkCard.id, { x: ORIGIN.x + 20, y: ORIGIN.y });

	// Managed data sits to the RIGHT of the cluster region — inside the VPC, outside Kubernetes.
	const dataX = clusterRight + 60;
	const dataY = clusterCard || inCluster.length ? ORIGIN.y + CARD_H + GAP_Y + 24 : ORIGIN.y;

	inNetwork.forEach((node, i) => {
		const col = i % DATA_COLS;
		const row = Math.floor(i / DATA_COLS);
		layout.set(node.id, {
			x: dataX + col * (CARD_W + GAP_X),
			y: dataY + row * (CARD_H + GAP_Y),
		});
	});

	const dataRows = Math.ceil(inNetwork.length / DATA_COLS);
	const dataCols = Math.min(DATA_COLS, Math.max(inNetwork.length, 0));
	const dataRight = inNetwork.length
		? dataX + dataCols * (CARD_W + GAP_X) - GAP_X
		: clusterRight;
	const dataBottom = inNetwork.length ? dataY + dataRows * (CARD_H + GAP_Y) : 0;

	// ── periphery: its own column, clear of the VPC ────────────────────────
	const peripheryX = Math.max(dataRight, clusterRight) + PERIPHERY_GAP;
	periphery.forEach((node, i) => {
		layout.set(node.id, {
			x: peripheryX,
			y: ORIGIN.y + i * (CARD_H + GAP_Y),
		});
	});

	// Nothing below needs the extents, but keeping them named documents the intent and makes the
	// next layout change (a cross-cloud island) obvious where to put.
	void clusterBottom;
	void dataBottom;

	return layout;
}

/** Apply a layout to a node list, leaving any node the layout didn't place exactly where it was. */
export function applyLayout(nodes: CanvasNode[], layout: Layout): CanvasNode[] {
	return nodes.map((node) => {
		const position = layout.get(node.id);
		return position ? { ...node, position } : node;
	});
}

/** The kinds that sit outside every zone. Exported for tests + the layout's own use. */
export function isPeripheryKind(
	kind: NodeKind,
	provider: CloudProviderSlug | null,
): boolean {
	return zoneForNode(kind, provider) === null;
}
