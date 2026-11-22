// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// What a connection drawn on the board means and when it may be drawn (#6835). The drag, the drop,
// the keyboard menu and the Delete key all ask these functions, so the rules are pinned here once.

import { describe, expect, it } from "vitest";
import {
	BINDABLE_KINDS,
	bindingsBehindEdge,
	bindingsOf,
	canEndConnection,
	canStartConnection,
	connectableTargets,
	evaluateConnection,
	withBinding,
	withoutBindings,
} from "@/components/design-project/canvas/edges/connection-rules";
import { NODE_REGISTRY } from "@/components/design-project/canvas/graph/node-registry";
import type { CanvasNode } from "@/components/design-project/canvas/graph/types";
import { collectionNodeId } from "@/lib/canvas/collections";
import { typedKeys } from "@/lib/typed-object";
import { serviceBindingSchema } from "@/lib/validations/project-form.schema";
import {
	cacheNode,
	chartNode,
	chartWorkloadNode,
	databaseNode,
	externalNode,
	projectNode,
	serviceNode,
} from "@/tests/fixtures/canvas/nodes";
import { bucketNode, secretNode } from "./fixtures";

const API = "service-api";
const ORDERS = "database-orders";

/** A board with a service `api`, a database, a cache, a bucket and two secrets. */
function board(bindings: Parameters<typeof serviceNode>[1] = []): CanvasNode[] {
	return [
		projectNode(),
		serviceNode("api", bindings),
		databaseNode("orders"),
		cacheNode("sessions"),
		bucketNode("assets"),
		secretNode("stripe"),
		secretNode("jwt"),
	];
}

describe("which cards a connection can start from and end at", () => {
	// Written out, not read back from the schema: a kind added to the binding enum must arrive here
	// as a failing test, because the board then draws a target handle on a new kind of card.
	it("the bindable kinds are the four the binding schema names", () => {
		expect([...BINDABLE_KINDS]).toEqual(["database", "cache", "queue", "secret"]);
	});

	it("only a service starts a connection", () => {
		const starters = typedKeys(NODE_REGISTRY).filter((kind) => canStartConnection(kind));
		expect(starters).toEqual(["service"]);
	});

	it("exactly the bindable kinds end one", () => {
		const enders = typedKeys(NODE_REGISTRY).filter((kind) => canEndConnection(kind));
		expect([...enders].sort()).toEqual([...BINDABLE_KINDS].sort());
	});
});

describe("evaluateConnection", () => {
	it("a service to a named database is one binding, addressed by kind and name", () => {
		expect(evaluateConnection(board(), API, ORDERS)).toEqual({
			outcome: "bind",
			sourceId: API,
			targetId: ORDERS,
			target: { kind: "database", name: "orders" },
		});
	});

	it("refuses a card that is not a database, cache, queue or secret, and says which kinds are", () => {
		const verdict = evaluateConnection(board(), API, "bucket-assets");
		expect(verdict.outcome).toBe("refused");
		expect(verdict).toMatchObject({
			reason: "A service connects to a database, cache, queue or secret. Bucket cannot be a connection target.",
		});
	});

	it("refuses a pair that is already connected, naming both ends", () => {
		const bound = board([{ target: { kind: "database", name: "orders" }, inject: [] }]);
		expect(evaluateConnection(bound, API, ORDERS)).toEqual({
			outcome: "refused",
			reason: "api is already connected to Database orders.",
		});
	});

	it("refuses a service connecting to itself", () => {
		expect(evaluateConnection(board(), API, API)).toMatchObject({
			outcome: "refused",
			reason: "A service cannot connect to itself.",
		});
	});

	it("refuses a target with no name, because a binding is saved by name", () => {
		const nodes = [projectNode(), serviceNode("api", []), databaseNode("")];
		expect(evaluateConnection(nodes, API, "database-")).toMatchObject({
			outcome: "refused",
			reason: "Name this database first. A connection is saved by the name of what it connects to.",
		});
	});

	it("refuses a source that is not a service", () => {
		expect(evaluateConnection(board(), ORDERS, "cache-sessions")).toMatchObject({
			outcome: "refused",
			reason: "Connections start from a service. Database cards do not connect to other cards.",
		});
	});

	it("sends a chart workload to its inspector instead", () => {
		const nodes = [...board(), chartNode("web"), chartWorkloadNode("w1", "web", [])];
		expect(evaluateConnection(nodes, "cw-w1", ORDERS)).toMatchObject({
			outcome: "refused",
			reason: "A chart workload's connections are set in its inspector, not drawn on the board.",
		});
	});

	it("sends a bring-your-own resource to the Connections tab, where its outputs are chosen", () => {
		const nodes = [...board(), externalNode("database|")];
		const verdict = evaluateConnection(nodes, API, "external-database|");
		expect(verdict.outcome).toBe("refused");
		expect(verdict).toMatchObject({ reason: expect.stringContaining("Connections tab") });
	});

	it("refuses a card that is no longer there", () => {
		expect(evaluateConnection(board(), API, "database-gone").outcome).toBe("refused");
		expect(evaluateConnection(board(), "service-gone", ORDERS).outcome).toBe("refused");
		expect(evaluateConnection(board(), null, ORDERS).outcome).toBe("refused");
	});

	it("the vault asks which secret, offering only the ones not connected yet", () => {
		const bound = board([{ target: { kind: "secret", name: "stripe" }, inject: [] }]);
		expect(evaluateConnection(bound, API, collectionNodeId("secret"))).toEqual({
			outcome: "choose",
			sourceId: API,
			kind: "secret",
			candidateIds: ["secret-jwt"],
		});
	});

	it("the vault refuses once every secret in it is connected", () => {
		const bound = board([
			{ target: { kind: "secret", name: "stripe" }, inject: [] },
			{ target: { kind: "secret", name: "jwt" }, inject: [] },
		]);
		expect(evaluateConnection(bound, API, collectionNodeId("secret"))).toEqual({
			outcome: "refused",
			reason: "api is already connected to everything in Secrets.",
		});
	});

	it("a collection of a kind nothing binds to is refused", () => {
		expect(evaluateConnection(board(), API, collectionNodeId("helm_registry"))).toMatchObject({
			outcome: "refused",
			reason: "A service connects to a database, cache, queue or secret. Chart repos cannot be a connection target.",
		});
	});
});

describe("the bindings a connection writes and removes", () => {
	it("a new binding names its target and injects nothing yet", () => {
		expect(withBinding([], { kind: "cache", name: "sessions" })).toEqual([
			{ target: { kind: "cache", name: "sessions" }, inject: [] },
		]);
	});

	it("a new binding passes the binding schema", () => {
		const [binding] = withBinding([], { kind: "queue", name: "jobs" });
		expect(serviceBindingSchema.safeParse(binding).success).toBe(true);
	});

	it("removing bindings keeps the others, in order", () => {
		const bindings = bindingsOf(
			serviceNode("api", [
				{ target: { kind: "database", name: "orders" }, inject: [] },
				{ target: { kind: "cache", name: "sessions" }, inject: [] },
				{ target: { kind: "secret", name: "jwt" }, inject: [] },
			]),
		);
		expect(
			withoutBindings(bindings, [{ kind: "cache", name: "sessions" }]).map((b) => b.target.name),
		).toEqual(["orders", "jwt"]);
	});

	it("a node that is not a service holds no bindings", () => {
		expect(bindingsOf(databaseNode("orders"))).toEqual([]);
		expect(bindingsOf(undefined)).toEqual([]);
	});

	it("connectableTargets lists every card a connection could be made to right now", () => {
		const bound = board([{ target: { kind: "database", name: "orders" }, inject: [] }]);
		expect(connectableTargets(bound, API).map((n) => n.id)).toEqual([
			"cache-sessions",
			"secret-stripe",
			"secret-jwt",
		]);
		expect(connectableTargets(bound, ORDERS)).toEqual([]);
	});

	it("an edge to one card stands for that one binding", () => {
		const bound = board([{ target: { kind: "database", name: "orders" }, inject: [] }]);
		expect(bindingsBehindEdge(bound, API, ORDERS)).toEqual([{ kind: "database", name: "orders" }]);
		expect(bindingsBehindEdge(bound, API, "cache-sessions")).toEqual([]);
	});

	it("an edge to the vault stands for every secret binding behind it", () => {
		const bound = board([
			{ target: { kind: "secret", name: "stripe" }, inject: [] },
			{ target: { kind: "database", name: "orders" }, inject: [] },
			{ target: { kind: "secret", name: "jwt" }, inject: [] },
		]);
		expect(bindingsBehindEdge(bound, API, collectionNodeId("secret"))).toEqual([
			{ kind: "secret", name: "stripe" },
			{ kind: "secret", name: "jwt" },
		]);
	});
});
