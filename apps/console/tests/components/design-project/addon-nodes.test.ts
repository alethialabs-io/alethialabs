// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Add-ons as citizens of the board.
//
// A marketplace add-on was configured in a sheet and explicitly NOT a graph node — so an installed
// Grafana was INVISIBLE on the architecture, even though it is an ArgoCD Application whose health
// and sync are already in the database. It's one of the last "states left behind".
//
// The load-bearing rule: they are OUT-OF-BAND. They're loaded from the server, never written by
// graphToForm, and must NEVER appear in the Deploy diff — an installed add-on is not a staged
// change, and letting one leak into the diff would make the Deploy button lie about what it does.

import { beforeEach, describe, expect, it } from "vitest";
import {
	diffNodes,
	OUT_OF_BAND,
	PROJECT_NODE_ID,
	useCanvasStore,
} from "@/lib/stores/use-canvas-store";
import { graphToForm } from "@/components/design-project/canvas/graph/graph-to-form";
import { NODE_REGISTRY } from "@/components/design-project/canvas/graph/node-registry";
import { zoneForNode } from "@/lib/canvas/zones";
import type { CanvasNode } from "@/components/design-project/canvas/graph/types";

const ADDONS = [
	{
		id: "kube-prometheus-stack",
		name: "kube-prometheus-stack",
		version: "62.3.0",
		namespace: "monitoring",
		status: "ACTIVE",
		health: "Degraded",
		sync: "OutOfSync",
	},
	{
		id: "loki",
		name: "loki",
		version: "6.10.0",
		namespace: "logging",
		status: "ACTIVE",
		health: "Healthy",
		sync: "Synced",
	},
];

function root(): CanvasNode {
	return {
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
}

beforeEach(() => {
	useCanvasStore.getState().reset();
});

describe("an installed add-on is finally visible on the architecture", () => {
	it("becomes a node", () => {
		useCanvasStore.getState().setAddonNodes(ADDONS);

		const addons = useCanvasStore
			.getState()
			.nodes.filter((n) => n.data.kind === "addon");
		expect(addons).toHaveLength(2);
	});

	it("carries the ArgoCD truth that was already in the database", () => {
		useCanvasStore.getState().setAddonNodes(ADDONS);

		const grafana = useCanvasStore
			.getState()
			.nodes.find((n) => n.id === "addon-kube-prometheus-stack");
		const config = grafana?.data.config as Record<string, unknown>;

		expect(config.health).toBe("Degraded");
		expect(config.sync).toBe("OutOfSync");
		expect(config.version).toBe("62.3.0");
	});

	it("shows chart · health · sync on its card", () => {
		const facts = (
			NODE_REGISTRY.addon.card.facts as (ctx: {
				config: unknown;
				provider: null;
			}) => { label: string; value: string }[]
		)({ config: ADDONS[0], provider: null });

		expect(facts.map((f) => f.label)).toEqual(["Chart", "Health", "Sync"]);
		expect(facts.map((f) => f.value)).toContain("Degraded");
	});

	it("runs INSIDE the cluster — it's a Kubernetes workload, not a cloud resource", () => {
		expect(zoneForNode("addon", "aws")).toBe("cluster");
	});

	it("is not keyboard-deletable — an add-on is removed by DISABLING it, not by Backspace", () => {
		useCanvasStore.getState().setAddonNodes(ADDONS);
		const addon = useCanvasStore
			.getState()
			.nodes.find((n) => n.data.kind === "addon");
		expect(addon?.deletable).toBe(false);
	});
});

// The rule that keeps this safe.
describe("out-of-band: an add-on is not a staged change", () => {
	it("never appears in the Deploy diff", () => {
		const baseline = [root()];
		useCanvasStore.setState({ nodes: [root()], baseline });
		useCanvasStore.getState().setAddonNodes(ADDONS);

		const changes = diffNodes(baseline, useCanvasStore.getState().nodes);

		// Two add-ons appeared on the board, and NOTHING is pending — because installing an add-on is
		// not a design change. If one leaked in, the Deploy button would be lying about what it does.
		expect(changes).toHaveLength(0);
	});

	it("is never written into the form graph", () => {
		useCanvasStore.setState({ nodes: [root()] });
		useCanvasStore.getState().setAddonNodes(ADDONS);

		const form = graphToForm(useCanvasStore.getState().nodes);

		// graphToForm reads only the kinds it knows; an add-on must not have leaked into any of them.
		expect(JSON.stringify(form)).not.toContain("kube-prometheus-stack");
	});

	it("declares both out-of-band kinds — charts and add-ons alike", () => {
		expect(OUT_OF_BAND.has("addon")).toBe(true);
		expect(OUT_OF_BAND.has("chart")).toBe(true);
		// …and nothing else. A designed resource IS a staged change.
		expect(OUT_OF_BAND.has("database")).toBe(false);
	});

	it("survives a form reseed — the server owns them, not the graph", () => {
		useCanvasStore.getState().setAddonNodes(ADDONS);
		useCanvasStore.getState().setGraph({ nodes: [root()] });

		const addons = useCanvasStore
			.getState()
			.nodes.filter((n) => n.data.kind === "addon");
		expect(addons).toHaveLength(2);
	});
});
