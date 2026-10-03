// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #5291: an accepted AI `update_config` proposal used to write its patch verbatim, so "make the
// nodes 4 vCPU / 16 GB" left the default instance type pinned beside the size — and Go deploys the
// pin, so the size was shown and ignored. It now goes through applySizingOneWriter, the same rule
// the inspector and the CLI apply.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyProposal } from "@/components/design-project/canvas/ai/apply-proposal";
import { NODE_REGISTRY } from "@/components/design-project/canvas/graph/node-registry";
import { nodeOfKind } from "@/components/design-project/canvas/graph/types";
import { PROJECT_NODE_ID, useCanvasStore } from "@/lib/stores/use-canvas-store";

const toastError = vi.fn();
vi.mock("sonner", () => ({ toast: { error: (m: string) => toastError(m), warning: vi.fn() } }));

const CLUSTER_ID = "cluster-1";

/** A canvas with a project root and a cluster holding the default pinned type. */
function seed() {
	useCanvasStore.setState({
		nodes: [
			{
				id: PROJECT_NODE_ID,
				type: "project",
				position: { x: 0, y: 0 },
				data: {
					kind: "project",
					config: NODE_REGISTRY.project.defaultData("gcp"),
					cloud_identity_id: null,
					provider: "gcp",
				},
			},
			{
				id: CLUSTER_ID,
				type: "cluster",
				position: { x: 0, y: 0 },
				data: {
					kind: "cluster",
					config: NODE_REGISTRY.cluster.defaultData("gcp"),
					cloud_identity_id: null,
					provider: "gcp",
				},
			},
		],
		baseline: [],
	});
}

/** The cluster node's current config. */
function clusterConfig() {
	const node = nodeOfKind(
		useCanvasStore.getState().nodes.find((n) => n.id === CLUSTER_ID),
		"cluster",
	);
	return node?.data.config;
}

/** Accept a proposal holding one update_config on the cluster. */
function accept(patch: Record<string, unknown>) {
	applyProposal({
		id: "p1",
		label: "resize",
		actions: [{ kind: "update_config", nodeId: CLUSTER_ID, patch }],
	});
}

beforeEach(() => {
	useCanvasStore.getState().reset();
	toastError.mockClear();
	seed();
});

describe("an AI update_config proposal obeys the one-writer rule", () => {
	it("setting node_size clears the pinned instance_types", () => {
		expect(clusterConfig()?.instance_types).toEqual(["e2-standard-2"]);
		accept({ node_size: { vcpu: 4, memory_gb: 16 } });
		expect(clusterConfig()?.node_size).toEqual({ vcpu: 4, memory_gb: 16 });
		expect(clusterConfig()?.instance_types).toEqual([]);
	});

	it("pinning an instance type clears node_size", () => {
		accept({ node_size: { vcpu: 4, memory_gb: 16 } });
		accept({ instance_types: ["n2-standard-4"] });
		expect(clusterConfig()?.instance_types).toEqual(["n2-standard-4"]);
		expect(clusterConfig()?.node_size).toBeUndefined();
	});

	it("a patch naming both is refused, said, and not applied", () => {
		accept({ node_size: { vcpu: 4, memory_gb: 16 }, instance_types: ["n2-standard-4"] });
		expect(toastError).toHaveBeenCalledTimes(1);
		expect(clusterConfig()?.instance_types).toEqual(["e2-standard-2"]);
		expect(clusterConfig()?.node_size).toBeUndefined();
	});

	it("a patch that touches neither passes through untouched", () => {
		accept({ node_desired_size: 4 });
		expect(clusterConfig()?.node_desired_size).toBe(4);
		expect(clusterConfig()?.instance_types).toEqual(["e2-standard-2"]);
	});
});
