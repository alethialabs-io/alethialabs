// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Zones make a large architecture read as an architecture. Flat, a managed database and an
// in-cluster Grafana are siblings — which is a lie about the system: a database lives IN the VPC but
// OUTSIDE Kubernetes, an add-on lives INSIDE the cluster, and a bucket has no VPC at all.
//
// Like collections, a zone is DERIVED — a bounding box over its members, not a React Flow parent —
// so there are no relative coordinates and the stored model is untouched. These tests defend that,
// the containment (the VPC always visibly encloses the cluster), and the per-cloud honesty (on a
// compute-only cloud the data services move INSIDE the cluster, because that's where they run).

import { describe, expect, it } from "vitest";
import {
	buildZones,
	isZoneId,
	zoneForNode,
	zoneNodeId,
	type ZoneNode,
} from "@/lib/canvas/zones";
import { layoutZoned, applyLayout } from "@/lib/canvas/layout";
import { NODE_REGISTRY } from "@/components/design-project/canvas/graph/node-registry";
import type { CanvasNode, NodeKind } from "@/components/design-project/canvas/graph/types";
import type { BoardNode } from "@/lib/canvas/collections";
import type { CloudProviderSlug } from "@/lib/cloud-providers";

function node(kind: NodeKind, x = 0, y = 0, name = kind): CanvasNode {
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

const zonesOf = (nodes: BoardNode[], provider: CloudProviderSlug = "aws") =>
	buildZones(nodes, (n) =>
		zoneForNode((n.data as { kind: NodeKind }).kind, provider),
	);

const find = (zones: ZoneNode[], id: "network" | "cluster") =>
	zones.find((z) => z.id === zoneNodeId(id));

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

describe("buildZones", () => {
	it("draws no region for a kind with no members", () => {
		expect(zonesOf([node("bucket")])).toHaveLength(0);
	});

	it("the VPC always visibly ENCLOSES the cluster, even when the cluster sits off to the side", () => {
		const nodes = [
			node("network", 80, 80),
			node("database", 900, 80), // data far to the right
			node("cluster", 100, 240), // cluster region well below-left
			node("chart", 100, 400),
		];
		const zones = zonesOf(nodes);
		const vpc = find(zones, "network");
		const cluster = find(zones, "cluster");

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

	it("paints regions BEHIND the cards — a card in front of its own zone is the point", () => {
		const zones = zonesOf([node("cluster"), node("chart")]);
		for (const zone of zones) expect(zone.zIndex).toBeLessThan(0);
	});

	it("nests the cluster above the VPC in the z-order, so the inner region is visible", () => {
		const zones = zonesOf([node("network"), node("cluster"), node("chart")]);
		expect(find(zones, "cluster")!.zIndex).toBeGreaterThan(
			find(zones, "network")!.zIndex,
		);
	});

	it("is inert — never draggable, selectable, or deletable", () => {
		const zones = zonesOf([node("cluster")]);
		for (const zone of zones) {
			expect(zone.draggable).toBe(false);
			expect(zone.selectable).toBe(false);
			expect(zone.deletable).toBe(false);
		}
	});

	it("re-bounds around a dragged card, because it's derived rather than a parent", () => {
		const before = zonesOf([node("cluster", 100, 100), node("chart", 100, 300)]);
		const after = zonesOf([node("cluster", 100, 100), node("chart", 100, 900)]);
		expect(after.find((z) => z.id === zoneNodeId("cluster"))!.height).toBeGreaterThan(
			before.find((z) => z.id === zoneNodeId("cluster"))!.height,
		);
	});

	it("does not mutate the nodes it bounds", () => {
		const nodes = [node("cluster", 10, 20), node("chart", 30, 40)];
		const before = structuredClone(nodes);
		zonesOf(nodes);
		expect(nodes).toEqual(before);
	});

	it("zone ids are recognisable, so they can be kept out of the store", () => {
		expect(isZoneId(zoneNodeId("cluster"))).toBe(true);
		expect(isZoneId("cluster-abc")).toBe(false);
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
		const zones = zonesOf(laid);

		const cluster = find(zones, "cluster")!;
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
		const vpc = find(zonesOf(laid), "network")!;
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
		const hetzner = () => "hetzner" as CloudProviderSlug;
		const nodes = [node("cluster"), node("database")];
		const laid = applyLayout(nodes, layoutZoned(nodes, hetzner));
		const zones = buildZones(laid, (n) =>
			zoneForNode((n.data as { kind: NodeKind }).kind, "hetzner"),
		);
		const cluster = find(zones, "cluster")!;
		const db = laid.find((n) => n.data.kind === "database")!;

		expect(db.position.x).toBeGreaterThanOrEqual(cluster.position.x);
		expect(db.position.x + 248).toBeLessThanOrEqual(cluster.position.x + cluster.width);
	});
});
