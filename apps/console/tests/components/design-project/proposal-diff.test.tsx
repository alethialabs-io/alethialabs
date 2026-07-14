// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The trust bug: the proposal card rendered only the model's own one-line `label` — a string the
// model wrote ABOUT ITSELF — while Accept applied a list of `actions` the user never saw. You were
// asked to approve a summary; what got applied was the payload.
//
// These tests pin that the payload is shown, with the BEFORE beside the after — "set min_capacity
// to 8" means nothing unless you know it was 0.5 — and that the assistant can now propose a
// REMOVAL, which it previously could reason about but never carry out.

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { ProposalDiff } from "@/components/design-project/canvas/ai/proposal-diff";
import { applyProposal } from "@/components/design-project/canvas/ai/apply-proposal";
import { summarizeCanvas } from "@/lib/ai/canvas-context";
import { NODE_REGISTRY } from "@/components/design-project/canvas/graph/node-registry";
import type { CanvasNode } from "@/components/design-project/canvas/graph/types";
import type { AiActionParsed } from "@/lib/ai/proposal";
import { PROJECT_NODE_ID, useCanvasStore } from "@/lib/stores/use-canvas-store";

/** A canvas with a project root and one database named `orders`. */
function seed() {
	const root = {
		id: PROJECT_NODE_ID,
		type: "project",
		position: { x: 0, y: 0 },
		data: {
			kind: "project",
			config: NODE_REGISTRY.project.defaultData("aws"),
			cloud_identity_id: null,
			provider: "aws",
		},
	} as CanvasNode;

	const db = {
		id: "database-1",
		type: "database",
		position: { x: 0, y: 0 },
		data: {
			kind: "database",
			config: {
				...NODE_REGISTRY.database.defaultData("aws"),
				name: "orders",
				min_capacity: 0.5,
			},
			cloud_identity_id: null,
			provider: "aws",
		},
	} as CanvasNode;

	useCanvasStore.setState({
		nodes: [root, db],
		identities: [
			{ id: "ident-aws", provider: "aws", displayId: "prod-eu" },
			{ id: "ident-gcp", provider: "gcp", displayId: "data-gcp" },
		] as never,
		baseline: [],
	});
}

const diff = (actions: AiActionParsed[]) => render(<ProposalDiff actions={actions} />);

beforeEach(() => {
	useCanvasStore.getState().reset();
	seed();
});

describe("Accept shows what it will actually do", () => {
	it("an update shows the OLD value beside the new one", () => {
		diff([
			{ kind: "update_config", nodeId: "database-1", patch: { min_capacity: 8 } },
		]);

		expect(screen.getByText("orders")).toBeInTheDocument();
		expect(screen.getByText("min_capacity")).toBeInTheDocument();
		// The before — without it, "set min_capacity to 8" tells you nothing.
		expect(screen.getByText("0.5")).toBeInTheDocument();
		expect(screen.getByText("8")).toBeInTheDocument();
	});

	it("an add names the resource and its settings", () => {
		diff([
			{
				kind: "add_node",
				nodeKind: "cache",
				config: { name: "sessions", engine: "valkey" },
			},
		]);

		expect(screen.getByText("sessions")).toBeInTheDocument();
		expect(screen.getByText(/engine valkey/)).toBeInTheDocument();
	});

	it("a cloud move shows where it's moving FROM and TO", () => {
		diff([
			{ kind: "set_identity", nodeId: "database-1", cloudIdentityId: "ident-gcp" },
		]);

		expect(screen.getByText("inherit project")).toBeInTheDocument();
		expect(screen.getByText("data-gcp")).toBeInTheDocument();
	});

	it("a removal names exactly what disappears", () => {
		diff([{ kind: "remove_node", nodeId: "database-1" }]);

		expect(screen.getByText(/Remove/)).toBeInTheDocument();
		expect(screen.getByText("orders")).toBeInTheDocument();
	});

	it("an absent value reads as an em dash, never as `undefined`", () => {
		diff([
			{ kind: "update_config", nodeId: "database-1", patch: { engine_version: "16" } },
		]);
		expect(screen.getByText("—")).toBeInTheDocument();
	});
});

// The assistant could add and reconfigure, but never remove — so "drop the cache, we don't need it"
// was something it could reason about and not carry out.
describe("the assistant can finally propose a removal", () => {
	it("applying a remove_node takes the node off the canvas", () => {
		applyProposal({
			id: "p1",
			label: "Remove the orders database",
			actions: [{ kind: "remove_node", nodeId: "database-1" }],
		});

		const kinds = useCanvasStore.getState().nodes.map((n) => n.data.kind);
		expect(kinds).not.toContain("database");
		// …and the project root survives — it is not removable.
		expect(kinds).toContain("project");
	});
});

describe("the assistant knows what you're looking at", () => {
	it("marks the focused node and tells the model to resolve pronouns to it", () => {
		const summary = summarizeCanvas({
			provider: "aws",
			form: {},
			nodes: [
				{ id: "database-1", kind: "database", name: "orders" },
				{ id: "cache-1", kind: "cache", name: "sessions" },
			],
			inspectorNodeId: "cache-1",
			selectedIds: ["cache-1"],
		});

		expect(summary).toContain("OPEN in the inspector");
		expect(summary).toContain("currently focused on: cache-1");
		expect(summary).toMatch(/Resolve "this"/);
	});

	it("says nothing about focus when nothing is selected — no phantom antecedent", () => {
		const summary = summarizeCanvas({
			provider: "aws",
			form: {},
			nodes: [{ id: "database-1", kind: "database", name: "orders" }],
		});

		expect(summary).not.toContain("currently focused on");
	});
});
