// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// What the board derives from its nodes (#6764): the field-level diff, a node's effective cloud,
// the design's revision, and the gate in front of Deploy. `deriveEdges` and `diffNodes` keep their
// own files (`tests/lib/canvas/derive-edges.test.ts`, `diff-nodes.test.ts`).

import { describe, expect, it } from "vitest";
import type { CanvasNode } from "@/components/design-project/canvas/graph/types";
import {
	deployGate,
	diffFields,
	diffNodes,
	draftRevision,
	effectiveIdentity,
	effectiveProvider,
	isDesignNode,
	planReviewState,
} from "@/lib/canvas/store/derive";
import {
	addonNode,
	cacheNode,
	databaseNode,
	projectNode,
} from "@/tests/fixtures/canvas/nodes";

const IDENTITIES = [
	{ id: "ident-aws", name: "prod", displayId: "1111", provider: "aws" },
	{ id: "ident-gcp", name: "data", displayId: "2222", provider: "gcp" },
];

/** `node` placed on another identity. */
function placedOn(node: CanvasNode, identityId: string): CanvasNode {
	return { ...node, data: { ...node.data, cloud_identity_id: identityId } } as CanvasNode;
}

describe("diffFields", () => {
	it("names the field, the saved value and the drafted value of an edit", () => {
		const baseline = [projectNode(), databaseNode("orders", 5432)];
		const draft = [projectNode(), databaseNode("orders", 6543)];
		expect(diffFields(baseline, draft)).toEqual([
			{
				id: "database-orders",
				op: "modified",
				kind: "database",
				name: "orders",
				field: "port",
				before: 5432,
				after: 6543,
			},
		]);
	});

	it("reports a new node and a removed node as one row each, with no field", () => {
		const baseline = [projectNode(), cacheNode("sessions")];
		const draft = [projectNode(), databaseNode("orders")];
		expect(diffFields(baseline, draft).map((r) => [r.id, r.op, r.field])).toEqual([
			["database-orders", "new", null],
			["cache-sessions", "removed", null],
		]);
	});

	it("reports a re-placement as a change of cloud_identity_id", () => {
		const baseline = [projectNode(), databaseNode("orders")];
		const draft = [projectNode(), placedOn(databaseNode("orders"), "ident-gcp")];
		expect(diffFields(baseline, draft)).toEqual([
			expect.objectContaining({ field: "cloud_identity_id", before: null, after: "ident-gcp" }),
		]);
	});

	it("covers exactly the nodes diffNodes reports", () => {
		const baseline = [projectNode(), databaseNode("orders"), cacheNode("sessions")];
		const draft = [projectNode(), databaseNode("orders", 1), databaseNode("audit"), addonNode("g")];
		const nodeIds = diffNodes(baseline, draft).map((c) => c.id).sort();
		const fieldIds = [...new Set(diffFields(baseline, draft).map((r) => r.id))].sort();
		expect(fieldIds).toEqual(nodeIds);
	});
});

describe("effectiveProvider and effectiveIdentity", () => {
	it("a node with no placement of its own takes the project root's", () => {
		const root = { ...projectNode(), data: { ...projectNode().data, provider: "gcp" } } as CanvasNode;
		const nodes = [root, databaseNode("orders")];
		expect(effectiveProvider(nodes, "database-orders")).toBe("gcp");
	});

	it("falls back to the identity list when no provider is stamped on the node", () => {
		const nodes = [placedOn(projectNode(), "ident-aws"), databaseNode("orders")];
		expect(effectiveProvider(nodes, "database-orders")).toBeNull();
		expect(effectiveProvider(nodes, "database-orders", IDENTITIES)).toBe("aws");
	});

	it("answers null for a node that is not there", () => {
		expect(effectiveProvider([projectNode()], "nope", IDENTITIES)).toBeNull();
		expect(effectiveIdentity([projectNode()], "nope", IDENTITIES)).toBeNull();
	});

	it("resolves a node's own identity before the project's", () => {
		const nodes = [
			placedOn(projectNode(), "ident-aws"),
			placedOn(databaseNode("orders"), "ident-gcp"),
			cacheNode("sessions"),
		];
		expect(effectiveIdentity(nodes, "database-orders", IDENTITIES)?.id).toBe("ident-gcp");
		expect(effectiveIdentity(nodes, "cache-sessions", IDENTITIES)?.id).toBe("ident-aws");
	});
});

describe("draftRevision", () => {
	it("is the same for the same design in new objects, wherever its cards sit", () => {
		const a = [projectNode(), databaseNode("orders")];
		const b = [projectNode(), { ...databaseNode("orders"), position: { x: 999, y: 999 } }];
		expect(draftRevision(a)).toBe(draftRevision(b));
	});

	it("moves when a field moves, and ignores cards the design does not own", () => {
		const base = [projectNode(), databaseNode("orders")];
		expect(draftRevision([projectNode(), databaseNode("orders", 1)])).not.toBe(draftRevision(base));
		expect(draftRevision([...base, addonNode("grafana")])).toBe(draftRevision(base));
		expect(isDesignNode(addonNode("grafana"))).toBe(false);
	});
});

describe("the gate in front of Deploy", () => {
	const design = [projectNode(), databaseNode("orders")];
	const plan = { planJobId: "plan-1", designRevision: draftRevision(design) };

	it("no reviewed plan: Deploy is not on offer", () => {
		expect(planReviewState(null, design)).toBe("none");
		expect(deployGate({ reviewedPlan: null, designNodes: design, baseline: design, operations: [] })).toEqual({
			allowed: false,
			reason: "no-plan",
			planJobId: null,
		});
	});

	it("a plan for exactly this saved design: Deploy is on offer, for that plan", () => {
		expect(planReviewState(plan, design)).toBe("current");
		expect(deployGate({ reviewedPlan: plan, designNodes: design, baseline: design, operations: [] })).toEqual({
			allowed: true,
			reason: "ok",
			planJobId: "plan-1",
		});
	});

	it("the design moved after the plan: the plan is stale and Deploy is not on offer", () => {
		const edited = [projectNode(), databaseNode("orders", 6543)];
		expect(planReviewState(plan, edited)).toBe("stale");
		expect(
			deployGate({ reviewedPlan: plan, designNodes: edited, baseline: design, operations: [] }),
		).toEqual({ allowed: false, reason: "stale-plan", planJobId: null });
	});

	it("the server says the plan is not current: stale, whatever the board recorded", () => {
		expect(
			deployGate({
				reviewedPlan: plan,
				designNodes: design,
				baseline: design,
				operations: [],
				serverCurrent: false,
			}).reason,
		).toBe("stale-plan");
	});

	it("a current plan with changes still unsaved: Deploy is not on offer", () => {
		const saved = [projectNode()];
		expect(
			deployGate({ reviewedPlan: plan, designNodes: design, baseline: saved, operations: [] }).reason,
		).toBe("unsaved-edits");
		expect(
			deployGate({
				reviewedPlan: plan,
				designNodes: design,
				baseline: design,
				operations: [
					{ id: "addon:g", target: "addon", verb: "install", targetId: "g", summary: "", input: {} },
				],
			}).reason,
		).toBe("unsaved-edits");
	});
});
