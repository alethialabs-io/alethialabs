// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The board's edges are DERIVED from the nodes, never drawn or stored as their own truth (#6762).
// These pin the whole edge list each case produces — ids, endpoints and types — over hand-built
// nodes, so the function can move to another module without the picture changing.

import { describe, expect, it } from "vitest";
import { deriveEdges } from "@/lib/canvas/store/derive";
import {
	cacheNode,
	chartNode,
	chartWorkloadNode,
	databaseNode,
	projectNode,
	serviceNode,
} from "@/tests/fixtures/canvas/nodes";

describe("deriveEdges", () => {
	it("draws nothing for a board with no binding", () => {
		expect(
			deriveEdges([projectNode(), databaseNode("orders"), serviceNode("api", [])]),
		).toEqual([]);
	});

	it("draws one edge for a binding, from the service to its target", () => {
		const nodes = [
			projectNode(),
			databaseNode("orders"),
			serviceNode("api", [
				{
					target: { kind: "database", name: "orders" },
					inject: [{ env: "DATABASE_HOST", from: "endpoint" }],
				},
			]),
		];
		expect(deriveEdges(nodes)).toEqual([
			{
				id: "bind:service-api->database-orders",
				source: "service-api",
				target: "database-orders",
				type: "binding",
			},
		]);
	});

	it("draws one edge for several injects to one target", () => {
		const nodes = [
			databaseNode("orders"),
			serviceNode("api", [
				{
					target: { kind: "database", name: "orders" },
					inject: [
						{ env: "DATABASE_HOST", from: "endpoint" },
						{ env: "DATABASE_PORT", from: "port" },
						{ env: "DATABASE_PASSWORD", from: "password" },
					],
				},
			]),
		];
		expect(deriveEdges(nodes).map((e) => e.id)).toEqual([
			"bind:service-api->database-orders",
		]);
	});

	it("draws one edge per target for a service bound to two resources", () => {
		const nodes = [
			databaseNode("orders"),
			cacheNode("sessions"),
			serviceNode("api", [
				{
					target: { kind: "database", name: "orders" },
					inject: [{ env: "DATABASE_HOST", from: "endpoint" }],
				},
				{
					target: { kind: "cache", name: "sessions" },
					inject: [{ env: "CACHE_HOST", from: "endpoint" }],
				},
			]),
		];
		expect(deriveEdges(nodes).map((e) => e.id)).toEqual([
			"bind:service-api->database-orders",
			"bind:service-api->cache-sessions",
		]);
	});

	it("draws nothing for a binding whose target is not placed", () => {
		const nodes = [
			databaseNode("orders"),
			serviceNode("api", [
				{
					target: { kind: "database", name: "invoices" },
					inject: [{ env: "DATABASE_HOST", from: "endpoint" }],
				},
			]),
		];
		expect(deriveEdges(nodes)).toEqual([]);
	});

	it("matches the target by kind as well as name", () => {
		// A cache called "orders" is not the database the binding names.
		const nodes = [
			cacheNode("orders"),
			serviceNode("api", [
				{
					target: { kind: "database", name: "orders" },
					inject: [{ env: "DATABASE_HOST", from: "endpoint" }],
				},
			]),
		];
		expect(deriveEdges(nodes)).toEqual([]);
	});

	it("draws a chart workload's parent edge and its binding edge", () => {
		const nodes = [
			databaseNode("orders"),
			chartNode("shop"),
			chartWorkloadNode("w1", "shop", [
				{
					target: { kind: "database", name: "orders" },
					inject: [{ env: "DATABASE_HOST", from: "endpoint" }],
				},
			]),
		];
		expect(deriveEdges(nodes)).toEqual([
			{
				id: "chart-shop->cw-w1",
				source: "chart-shop",
				target: "cw-w1",
				type: "dependency",
			},
			{
				id: "cwbind:cw-w1->database-orders",
				source: "cw-w1",
				target: "database-orders",
				type: "cw_binding",
			},
		]);
	});

	it("draws no parent edge for a chart workload whose chart is not on the board", () => {
		expect(deriveEdges([chartWorkloadNode("w1", "shop", [])])).toEqual([]);
	});

	it("keeps every edge id when the nodes are reordered, copied or moved", () => {
		const nodes = [
			projectNode(),
			databaseNode("orders"),
			serviceNode("api", [
				{
					target: { kind: "database", name: "orders" },
					inject: [{ env: "DATABASE_HOST", from: "endpoint" }],
				},
			]),
			chartNode("shop"),
			chartWorkloadNode("w1", "shop", [
				{
					target: { kind: "database", name: "orders" },
					inject: [{ env: "DATABASE_HOST", from: "endpoint" }],
				},
			]),
		];
		const ids = deriveEdges(nodes)
			.map((e) => e.id)
			.sort();
		expect(ids).toEqual([
			"bind:service-api->database-orders",
			"chart-shop->cw-w1",
			"cwbind:cw-w1->database-orders",
		]);

		const moved = structuredClone(nodes)
			.reverse()
			.map((n) => ({ ...n, position: { x: n.position.x + 400, y: n.position.y + 90 } }));
		expect(
			deriveEdges(moved)
				.map((e) => e.id)
				.sort(),
		).toEqual(ids);
		// And the same call twice gives the same ids: nothing random or counted goes into one.
		expect(
			deriveEdges(nodes)
				.map((e) => e.id)
				.sort(),
		).toEqual(ids);
	});
});
