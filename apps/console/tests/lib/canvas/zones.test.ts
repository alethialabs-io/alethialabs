// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Containers make a large architecture read as an architecture. Flat, a managed database and an
// in-cluster Grafana are siblings — which is a lie about the system: a database lives IN the VPC but
// OUTSIDE Kubernetes, an add-on lives INSIDE the cluster, and a bucket has no VPC at all.
//
// A container's geometry is DERIVED from its members (a padded bounding box) until the user drags or
// resizes it, at which point their chosen box is remembered as an override. Cards keep ABSOLUTE
// positions and are NOT React Flow children, so the stored model is untouched. These tests defend
// that, the containment (the VPC always visibly encloses the cluster), the per-cloud honesty, the
// override, and the drag member-sets (the nested double-move guard).

import { describe, expect, it } from "vitest";
import {
	buildContainers,
	containerOfBoardNode,
	dragMemberIds,
	isContainerId,
	isZoneId,
	zoneForNode,
	zoneNodeId,
	EXTERNAL_CONTAINER_ID,
	type ContainerNode,
} from "@/lib/canvas/zones";
import { layoutZoned, applyLayout } from "@/lib/canvas/layout";
import { NODE_REGISTRY } from "@/components/design-project/canvas/graph/node-registry";
import type { CanvasNode, NodeKind } from "@/components/design-project/canvas/graph/types";
import type { BoardNode } from "@/lib/canvas/collections";
import type { CloudProviderSlug } from "@/lib/cloud-providers";

function node(kind: NodeKind, x = 0, y = 0, name: string = kind): CanvasNode {
	return {
		id: `${kind}-${name}`,
		type: kind,
		position: { x, y },
		data: {
			kind,
			config: { ...NODE_REGISTRY[kind].defaultData("aws"), name },
			cloud_identity_id: null,
			provider: "aws",
		},
	} as CanvasNode;
}

/** An external (BYO-IaC) card, wearing a mapped kind's face but owned by the module region. */
function externalNode(key: string, mappedKind: NodeKind | null, x = 0, y = 0): CanvasNode {
	return {
		id: `external-${key}`,
		type: "external",
		position: { x, y },
		data: {
			kind: "external",
			config: { key, mappedKind, module: `module.${key}`, source: "plan", members: [] },
			cloud_identity_id: null,
			provider: null,
		},
	} as unknown as CanvasNode;
}

const containerOf = (provider: CloudProviderSlug) => (n: BoardNode) =>
	containerOfBoardNode(n, () => provider);

const containersOf = (nodes: BoardNode[], provider: CloudProviderSlug = "aws") =>
	buildContainers(nodes, containerOf(provider), {});

const find = (containers: ContainerNode[], id: "network" | "cluster") =>
	containers.find((c) => c.id === zoneNodeId(id));

describe("where a resource actually runs", () => {
	it("managed data services live in the VPC, outside Kubernetes", () => {
		expect(zoneForNode("database", "aws")).toBe("network");
		expect(zoneForNode("cache", "aws")).toBe("network");
		expect(zoneForNode("nosql", "aws")).toBe("network");
	});

	it("Helm charts are Kubernetes workloads — they run inside the cluster", () => {
		expect(zoneForNode("chart", "aws")).toBe("cluster");
	});

	it("periphery has no VPC at all — which is exactly why it may diverge to another cloud", () => {
		expect(zoneForNode("dns", "aws")).toBeNull();
		expect(zoneForNode("bucket", "aws")).toBeNull();
		expect(zoneForNode("secret", "aws")).toBeNull();
		expect(zoneForNode("registry", "aws")).toBeNull();
		expect(zoneForNode("repositories", "aws")).toBeNull();
	});

	// The per-cloud honesty — the same one the card's facts already carry.
	it("on a compute-only cloud the data services move INSIDE the cluster (they're Helm charts there)", () => {
		expect(zoneForNode("database", "hetzner")).toBe("cluster");
		expect(zoneForNode("cache", "hetzner")).toBe("cluster");
		expect(zoneForNode("queue", "hetzner")).toBe("cluster");
	});

	it("…while on a managed cloud the very same kinds stay in the VPC", () => {
		expect(zoneForNode("database", "gcp")).toBe("network");
		expect(zoneForNode("database", "azure")).toBe("network");
	});
});

describe("buildContainers", () => {
	it("draws no region for a kind with no members", () => {
		expect(containersOf([node("bucket")])).toHaveLength(0);
	});

	it("the VPC always visibly ENCLOSES the cluster, even when the cluster sits off to the side", () => {
		const nodes = [
			node("network", 80, 80),
			node("database", 900, 80), // data far to the right
			node("cluster", 100, 240), // cluster region well below-left
			node("chart", 100, 400),
		];
		const containers = containersOf(nodes);
		const vpc = find(containers, "network");
		const cluster = find(containers, "cluster");

		expect(vpc).toBeDefined();
		expect(cluster).toBeDefined();

		// Containment, on every side.
		expect(vpc!.position.x).toBeLessThanOrEqual(cluster!.position.x);
		expect(vpc!.position.y).toBeLessThanOrEqual(cluster!.position.y);
		expect(vpc!.position.x + vpc!.width).toBeGreaterThanOrEqual(
			cluster!.position.x + cluster!.width,
		);
		expect(vpc!.position.y + vpc!.height).toBeGreaterThanOrEqual(
			cluster!.position.y + cluster!.height,
		);
	});

	it("paints regions BEHIND the cards — a card in front of its own region is the point", () => {
		const containers = containersOf([node("cluster"), node("chart")]);
		for (const c of containers) expect(c.zIndex).toBeLessThan(0);
	});

	it("nests the cluster above the VPC in the z-order, so the inner region is visible", () => {
		const containers = containersOf([node("network"), node("cluster"), node("chart")]);
		expect(find(containers, "cluster")!.zIndex).toBeGreaterThan(
			find(containers, "network")!.zIndex,
		);
	});

	it("is now interactive — draggable and selectable, but never keyboard-deletable", () => {
		const containers = containersOf([node("cluster")]);
		for (const c of containers) {
			expect(c.draggable).toBe(true);
			expect(c.selectable).toBe(true);
			expect(c.deletable).toBe(false);
		}
	});

	it("re-bounds around a dragged card while DERIVED (no override)", () => {
		const before = containersOf([node("cluster", 100, 100), node("chart", 100, 300)]);
		const after = containersOf([node("cluster", 100, 100), node("chart", 100, 900)]);
		expect(after.find((c) => c.id === zoneNodeId("cluster"))!.height).toBeGreaterThan(
			before.find((c) => c.id === zoneNodeId("cluster"))!.height,
		);
	});

	it("a user override wins over the derived box, and preserves the auto-fit size as the resize minimum", () => {
		const nodes = [node("cluster", 100, 100), node("chart", 100, 300)];
		const derived = find(containersOf(nodes), "cluster")!;
		const override = { x: 500, y: 500, width: 900, height: 900 };
		const containers = buildContainers(nodes, containerOf("aws"), {
			[zoneNodeId("cluster")]: override,
		});
		const cluster = find(containers, "cluster")!;
		expect(cluster.position).toEqual({ x: 500, y: 500 });
		expect(cluster.width).toBe(900);
		expect(cluster.height).toBe(900);
		expect(cluster.data.pinned).toBe(true);
		// The resizer floor stays the members' real bounds, so a resize can never clip them.
		expect(cluster.data.minWidth).toBe(derived.width);
		expect(cluster.data.minHeight).toBe(derived.height);
	});

	it("does not draw a region that has no members, even when a stale override lingers", () => {
		const containers = buildContainers([node("bucket")], containerOf("aws"), {
			[zoneNodeId("cluster")]: { x: 0, y: 0, width: 100, height: 100 },
		});
		expect(containers.find((c) => c.id === zoneNodeId("cluster"))).toBeUndefined();
	});

	it("groups EVERY external card into one BYO-module region — not the VPC/cluster", () => {
		const nodes = [
			externalNode("vpc", "network", 100, 100),
			externalNode("eks", "cluster", 100, 300),
		];
		const containers = buildContainers(nodes, containerOf("aws"), {});
		const moduleRegion = containers.find((c) => c.id === EXTERNAL_CONTAINER_ID);
		expect(moduleRegion).toBeDefined();
		expect(moduleRegion!.data.zone).toBe("external");
		expect(moduleRegion!.data.memberCount).toBe(2);
		// Whole-module decision: external cards do NOT also form VPC/cluster regions.
		expect(containers.find((c) => c.id === zoneNodeId("network"))).toBeUndefined();
		expect(containers.find((c) => c.id === zoneNodeId("cluster"))).toBeUndefined();
	});

	it("does not mutate the nodes it bounds", () => {
		const nodes = [node("cluster", 10, 20), node("chart", 30, 40)];
		const before = structuredClone(nodes);
		containersOf(nodes);
		expect(nodes).toEqual(before);
	});

	it("container ids are recognisable, so they can be kept out of the store", () => {
		expect(isZoneId(zoneNodeId("cluster"))).toBe(true);
		expect(isContainerId(zoneNodeId("cluster"))).toBe(true);
		expect(isContainerId(EXTERNAL_CONTAINER_ID)).toBe(true);
		expect(isContainerId("cluster-abc")).toBe(false);
		expect(isZoneId(EXTERNAL_CONTAINER_ID)).toBe(false);
	});
});

describe("dragMemberIds — what moves when a region is dragged (the nested guard)", () => {
	const co = containerOf("aws");

	it("dragging the VPC carries its own members AND the cluster's, each exactly once", () => {
		const nodes = [
			node("network"),
			node("database", 0, 0, "db"),
			node("cluster"),
			node("chart"),
		];
		const ids = dragMemberIds(nodes, zoneNodeId("network"), co);
		expect(new Set(ids).size).toBe(ids.length); // no double-move
		expect(ids).toEqual(
			expect.arrayContaining(["network-network", "database-db", "cluster-cluster", "chart-chart"]),
		);
	});

	it("dragging the cluster carries only cluster members", () => {
		const nodes = [node("network"), node("database"), node("cluster"), node("chart")];
		const ids = dragMemberIds(nodes, zoneNodeId("cluster"), co);
		expect(ids).toEqual(expect.arrayContaining(["cluster-cluster", "chart-chart"]));
		expect(ids).not.toContain("network-network");
		expect(ids).not.toContain("database-database");
	});

	it("dragging the module carries its external cards", () => {
		const nodes = [externalNode("vpc", "network"), externalNode("eks", "cluster")];
		const ids = dragMemberIds(nodes, EXTERNAL_CONTAINER_ID, co).sort();
		expect(ids).toEqual(["external-eks", "external-vpc"]);
	});

	it("a periphery card belongs to no region and never moves with one", () => {
		const nodes = [node("cluster"), node("bucket")];
		expect(dragMemberIds(nodes, zoneNodeId("cluster"), co)).not.toContain("bucket-bucket");
		expect(dragMemberIds(nodes, zoneNodeId("network"), co)).not.toContain("bucket-bucket");
	});
});

describe("layoutZoned", () => {
	const aws = () => "aws" as CloudProviderSlug;

	it("puts the in-cluster workloads inside the cluster region and the data beside it", () => {
		const nodes = [
			node("network"),
			node("cluster"),
			node("chart"),
			node("database"),
		];
		const laid = applyLayout(nodes, layoutZoned(nodes, aws));
		const containers = containersOf(laid);

		const cluster = find(containers, "cluster")!;
		const chart = laid.find((n) => n.data.kind === "chart")!;
		const database = laid.find((n) => n.data.kind === "database")!;

		// The chart lands inside the cluster region…
		expect(chart.position.x).toBeGreaterThanOrEqual(cluster.position.x);
		expect(chart.position.x).toBeLessThanOrEqual(cluster.position.x + cluster.width);
		// …and the managed database does NOT.
		expect(database.position.x).toBeGreaterThan(cluster.position.x + cluster.width);
	});

	it("puts periphery clear of the VPC entirely", () => {
		const nodes = [node("network"), node("cluster"), node("database"), node("bucket")];
		const laid = applyLayout(nodes, layoutZoned(nodes, aws));
		const vpc = find(containersOf(laid), "network")!;
		const bucket = laid.find((n) => n.data.kind === "bucket")!;

		expect(bucket.position.x).toBeGreaterThan(vpc.position.x + vpc.width);
	});

	it("never places the project root — it's the data anchor and is never drawn", () => {
		const root = node("project");
		expect(layoutZoned([root], aws).has(root.id)).toBe(false);
	});

	it("is deterministic — the same graph lays out the same way", () => {
		const nodes = [node("cluster"), node("database"), node("bucket")];
		expect([...layoutZoned(nodes, aws)]).toEqual([...layoutZoned(nodes, aws)]);
	});

	it("leaves a node the layout didn't place exactly where it was", () => {
		const orphan = { ...node("bucket", 999, 999), id: "unplaced" };
		const [out] = applyLayout([orphan], new Map());
		expect(out.position).toEqual({ x: 999, y: 999 });
	});

	// The compute-only cloud lays out DIFFERENTLY — and correctly.
	it("on a compute-only cloud the database lands INSIDE the cluster region", () => {
		const nodes = [node("cluster"), node("database")];
		const laid = applyLayout(nodes, layoutZoned(nodes, () => "hetzner" as CloudProviderSlug));
		const containers = buildContainers(laid, containerOf("hetzner"), {});
		const cluster = find(containers, "cluster")!;
		const db = laid.find((n) => n.data.kind === "database")!;

		expect(db.position.x).toBeGreaterThanOrEqual(cluster.position.x);
		expect(db.position.x + 248).toBeLessThanOrEqual(cluster.position.x + cluster.width);
	});
});
