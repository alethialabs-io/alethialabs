// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// W5 Path A (Lane 3) — the described chart-workload inspector panel. It renders the READ-ONLY
// description from the real read model (image / kind / rendered env keys) and the editable overlay
// (the reused W3 BindingsField + a Save action). These pin that the panel mounts against the real
// ChartWorkloadNodeConfig shape and shows the read-mostly surface.

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The persist actions pull in the server DB/authz chain — mock them so the panel mounts in jsdom.
vi.mock("@/app/server/actions/byo-charts", () => ({
	setChartWorkloadBindings: vi.fn(),
	setChartWorkloadConfig: vi.fn(),
	setChartWorkloadValuePaths: vi.fn(),
}));

import { useCanvasStore } from "@/lib/stores/use-canvas-store";
import type { CanvasNode } from "@/components/design-project/canvas/graph/types";
import { ChartWorkloadPanel } from "@/components/design-project/canvas/inspector/chart-workload-panel";

/** A described-workload node seeded straight into the store (as the loader would build it). */
function workloadNode(): CanvasNode {
	return {
		id: "cw-w1",
		type: "chart_workload",
		deletable: false,
		position: { x: 0, y: 0 },
		data: {
			kind: "chart_workload",
			config: {
				id: "w1",
				chartId: "web-chart",
				name: "web",
				kind: "deployment",
				rendered: {
					image: "ghcr.io/acme/web:1.2.3",
					ports: [{ container_port: 8080 }],
					env_keys: ["LOG_LEVEL", "DB_URL"],
					replicas: 3,
				},
				bindings: [],
				config: {},
				valuePaths: {},
			},
			cloud_identity_id: null,
			provider: null,
		},
	} as unknown as CanvasNode;
}

beforeEach(() => {
	useCanvasStore.getState().reset();
	useCanvasStore.setState({ nodes: [workloadNode()] });
});

describe("ChartWorkloadPanel", () => {
	it("renders the read-only description from the real read model", () => {
		render(<ChartWorkloadPanel nodeId="cw-w1" />);
		// Name + the not-owned "Chart workload" eyebrow.
		expect(screen.getByText("web")).toBeInTheDocument();
		expect(screen.getByText("Chart workload")).toBeInTheDocument();
		// The rendered description (read-only).
		expect(screen.getByText("ghcr.io/acme/web:1.2.3")).toBeInTheDocument();
		// Env is shown as KEY NAMES only.
		expect(screen.getByText("LOG_LEVEL")).toBeInTheDocument();
		expect(screen.getByText("DB_URL")).toBeInTheDocument();
	});

	it("surfaces the editable overlay (bindings + save)", () => {
		render(<ChartWorkloadPanel nodeId="cw-w1" />);
		expect(screen.getByText("Bindings")).toBeInTheDocument();
		expect(screen.getByText("Value paths")).toBeInTheDocument();
		// The reused W3 binding editor's add affordance.
		expect(screen.getByText("Bind a resource")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /save overlay/i })).toBeInTheDocument();
	});

	it("returns nothing for an unknown node id", () => {
		const { container } = render(<ChartWorkloadPanel nodeId="cw-missing" />);
		expect(container).toBeEmptyDOMElement();
	});
});
