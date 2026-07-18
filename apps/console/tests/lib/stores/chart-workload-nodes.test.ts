// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// W5 Path A (Lane 3) — described chart-workload nodes are out-of-band (never a staged change), render
// as children of their parent chart node, and derive their edges from the model exactly like the
// service binding rule: a solid chart→workload parent edge + a dotted workload→resource binding edge
// per placed binding. These tests pin that wiring end-to-end through the store.

import { beforeEach, describe, expect, it } from "vitest";
import { PROJECT_NODE_ID, useCanvasStore } from "@/lib/stores/use-canvas-store";
import type {
	ByoChartState,
	ChartWorkloadState,
} from "@/app/server/actions/byo-charts";
import type { CanvasNode } from "@/components/design-project/canvas/graph/types";

function projectNode(): CanvasNode {
	return {
		id: PROJECT_NODE_ID,
		type: "project",
		position: { x: 0, y: 0 },
		data: {
			kind: "project",
			config: { project_name: "p" },
			cloud_identity_id: null,
			provider: "aws",
		},
	} as unknown as CanvasNode;
}

function dbNode(name: string): CanvasNode {
	return {
		id: `database-${name}`,
		type: "database",
		position: { x: 0, y: 300 },
		data: {
			kind: "database",
			config: { name },
			cloud_identity_id: null,
			provider: "aws",
		},
	} as unknown as CanvasNode;
}

/** A minimal attached BYO chart (only the fields setChartNodes reads matter for the node id). */
function chart(id: string): ByoChartState {
	return {
		id,
		repoUrl: "https://github.com/acme/charts",
		chartPath: "charts/web",
		ref: "HEAD",
		namespace: "default",
		values: {},
		valuesYaml: null,
		status: "PENDING",
		health: null,
		sync: null,
		lastSyncedAt: null,
		scanStatus: "done",
		scanReport: null,
		scannedAt: null,
	} as unknown as ByoChartState;
}

/** A described workload of a chart. `bindings` drives the binding edges. */
function workload(
	over: Partial<ChartWorkloadState> & Pick<ChartWorkloadState, "id" | "chartId">,
): ChartWorkloadState {
	return {
		name: "web",
		kind: "deployment",
		rendered: { image: "ghcr.io/acme/web:1", ports: [], env_keys: [] },
		bindings: [],
		config: {},
		valuePaths: {},
		...over,
	};
}

function seed(nodes: CanvasNode[]) {
	useCanvasStore.setState({
		nodes,
		baseline: structuredClone(nodes),
		past: [],
		future: [],
		dirty: false,
	});
}

beforeEach(() => {
	useCanvasStore.getState().reset();
});

describe("setChartWorkloadNodes", () => {
	it("builds a non-deletable child node per described workload and a chart→workload edge", () => {
		const s = useCanvasStore.getState();
		s.setChartNodes([chart("pg")]);
		s.setChartWorkloadNodes([workload({ id: "w1", chartId: "pg", name: "web" })]);

		const state = useCanvasStore.getState();
		const cw = state.nodes.find((n) => n.id === "cw-w1");
		expect(cw).toBeDefined();
		expect(cw?.data.kind).toBe("chart_workload");
		expect(cw?.deletable).toBe(false);

		// A solid parent edge from the chart node to its described workload.
		expect(
			state.edges.some((e) => e.source === "chart-pg" && e.target === "cw-w1"),
		).toBe(true);
	});

	it("draws a dotted binding edge to a placed backing resource, and nothing when unplaced", () => {
		seed([projectNode(), dbNode("orders-db")]);
		const s = useCanvasStore.getState();
		s.setChartNodes([chart("pg")]);
		s.setChartWorkloadNodes([
			workload({
				id: "w1",
				chartId: "pg",
				bindings: [
					{
						target: { kind: "database", name: "orders-db" },
						inject: [{ env: "DB_URL", from: "connection_string" }],
					},
				],
			}),
			// A binding whose target isn't on the canvas → no edge (never a dangling edge).
			workload({
				id: "w2",
				chartId: "pg",
				name: "worker",
				bindings: [
					{ target: { kind: "cache", name: "not-placed" }, inject: [] },
				],
			}),
		]);

		const { edges } = useCanvasStore.getState();
		const bind = edges.filter((e) => e.type === "cw_binding");
		expect(bind).toHaveLength(1);
		expect(bind[0]).toMatchObject({
			source: "cw-w1",
			target: "database-orders-db",
			type: "cw_binding",
		});
	});

	it("preserves described-workload nodes across a form reseed (out-of-band)", () => {
		const s = useCanvasStore.getState();
		s.setChartNodes([chart("pg")]);
		s.setChartWorkloadNodes([workload({ id: "w1", chartId: "pg" })]);

		// A form reseed carries only form-graph nodes; out-of-band nodes must survive it.
		s.setGraph({ nodes: [projectNode()] });

		const state = useCanvasStore.getState();
		expect(state.nodes.some((n) => n.id === "cw-w1")).toBe(true);
		expect(state.nodes.some((n) => n.id === "chart-pg")).toBe(true);
	});

	it("replaces workloads on each call (never accumulates stale rows)", () => {
		const s = useCanvasStore.getState();
		s.setChartNodes([chart("pg")]);
		s.setChartWorkloadNodes([workload({ id: "w1", chartId: "pg" })]);
		s.setChartWorkloadNodes([workload({ id: "w2", chartId: "pg", name: "worker" })]);

		const ids = useCanvasStore
			.getState()
			.nodes.filter((n) => n.data.kind === "chart_workload")
			.map((n) => n.id);
		expect(ids).toEqual(["cw-w2"]);
	});
});
