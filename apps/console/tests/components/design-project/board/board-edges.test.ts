// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The edges the board draws, from the edges the design derives (#6835): re-pointed at the card that
// shows each end, folded where the vault made copies, named for a screen reader, and marked with
// whether Delete removes them.

import { describe, expect, it } from "vitest";
import {
	buildBoardEdges,
	cardTitles,
	connectionsByCard,
} from "@/components/design-project/canvas/edges/board-edges";
import type { CanvasNode } from "@/components/design-project/canvas/graph/types";
import { collectionNodeId } from "@/lib/canvas/collections";
import { deriveEdges } from "@/lib/canvas/store/derive";
import {
	chartNode,
	chartWorkloadNode,
	databaseNode,
	projectNode,
	serviceNode,
} from "@/tests/fixtures/canvas/nodes";
import { secretNode } from "./fixtures";

const VAULT = collectionNodeId("secret");

/** A service bound to a database and to two secrets, beside a chart with one described workload. */
function design(): CanvasNode[] {
	return [
		projectNode(),
		serviceNode("api", [
			{ target: { kind: "database", name: "orders" }, inject: [] },
			{ target: { kind: "secret", name: "stripe" }, inject: [] },
			{ target: { kind: "secret", name: "jwt" }, inject: [] },
		]),
		databaseNode("orders"),
		secretNode("stripe"),
		secretNode("jwt"),
		chartNode("web"),
		chartWorkloadNode("w1", "web", [{ target: { kind: "database", name: "orders" }, inject: [] }]),
	];
}

/** The ids of the cards the board draws for `design()`: the vault stands in for both secrets. */
const DRAWN = new Set(["service-api", "database-orders", VAULT, "chart-web", "cw-w1"]);

/** The board edges of `design()`, by id. */
function edgesById() {
	const nodes = design();
	return new Map(buildBoardEdges(deriveEdges(nodes), nodes, DRAWN).map((e) => [e.id, e]));
}

describe("buildBoardEdges", () => {
	it("keeps a binding edge between two drawn cards, under the id the store gave it", () => {
		const edge = edgesById().get("bind:service-api->database-orders");
		expect(edge).toMatchObject({
			source: "service-api",
			target: "database-orders",
			type: "binding",
			data: { count: 1, locked: null },
			ariaLabel: "Connection from Service api to Database orders",
		});
	});

	it("folds the edges to collapsed members into ONE line that knows how many it stands for", () => {
		const toVault = [...edgesById().values()].filter((e) => e.target === VAULT);
		expect(toVault).toHaveLength(1);
		expect(toVault[0]).toMatchObject({
			source: "service-api",
			data: { count: 2, locked: null },
			ariaLabel: "2 connections from Service api to Secrets",
		});
	});

	it("every line is a focus stop that React Flow itself may not delete", () => {
		const flags = [...edgesById().values()].map((e) => [e.focusable, e.selectable, e.deletable]);
		expect(flags).toHaveLength(4);
		expect(flags.every(([focusable, selectable, deletable]) => focusable && selectable && !deletable)).toBe(true);
	});

	it("a chart workload's binding is locked, and says where it is changed", () => {
		const edge = [...edgesById().values()].find((e) => e.type === "cw_binding");
		expect(edge?.data?.locked).toBe(
			"This connection belongs to a chart workload. Change it in the workload's inspector.",
		);
		expect(edge?.ariaLabel).toBe("Connection from Chart workload web to Database orders");
	});

	it("the line from a chart to its workload is a link, not a connection, and is locked", () => {
		const edge = [...edgesById().values()].find((e) => e.type === "dependency");
		expect(edge?.ariaLabel).toBe("Link from Helm chart web to Chart workload web");
		expect(edge?.data?.locked).toContain("cannot be removed");
	});

	it("drops an edge whose end has no card on the board", () => {
		const nodes = design();
		const drawn = new Set([...DRAWN].filter((id) => id !== "database-orders"));
		const edges = buildBoardEdges(deriveEdges(nodes), nodes, drawn);
		expect(edges.some((e) => e.target === "database-orders")).toBe(false);
	});
});

describe("what each card is connected to", () => {
	it("cardTitles names every store node and every collapsed kind", () => {
		const titles = cardTitles(design());
		expect(titles.get("service-api")).toBe("Service api");
		expect(titles.get("chart-web")).toBe("Helm chart web");
		expect(titles.get(VAULT)).toBe("Secrets");
	});

	it("connectionsByCard lists both ends of every line", () => {
		const nodes = design();
		const byCard = connectionsByCard(
			buildBoardEdges(deriveEdges(nodes), nodes, DRAWN),
			cardTitles(nodes),
		);
		expect(byCard.get("service-api")).toEqual(["Database orders", "Secrets"]);
		expect(byCard.get("database-orders")).toEqual(["Service api", "Chart workload web"]);
		expect(byCard.get(VAULT)).toEqual(["Service api"]);
	});
});
