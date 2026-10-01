// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #5269: re-placing a cluster on another cloud's identity rewrote only its placement, so an AWS
// cluster moved onto a GCP account still said `["t3.large"]` and failed at plan, inside GCP's API.
// The store now maps a pinned machine type through the same rule the whole-project conversion uses
// (convert.ts's convertInstanceTypes), and RETURNS the notice when it had to fall back to a default.

import { beforeEach, describe, expect, it } from "vitest";
import { PROJECT_NODE_ID, useCanvasStore } from "@/lib/stores/use-canvas-store";
import type { CanvasNode } from "@/components/design-project/canvas/graph/types";
import type { CloudProviderSlug } from "@/lib/cloud-providers";
import type { NodeSize } from "@/types/jsonb.types";

const CLUSTER_ID = "cluster-main";

/** The project root, placed on `provider`. */
function projectNode(provider: CloudProviderSlug | null): CanvasNode<"project"> {
	return {
		id: PROJECT_NODE_ID,
		type: "project",
		position: { x: 0, y: 0 },
		data: {
			kind: "project",
			config: {
				project_name: "p",
				region: "eu-west-1",
				iac_version: "1.9.5",
				environment_stage: "production",
			},
			cloud_identity_id: null,
			provider,
		},
	};
}

/** A cluster node with its own placement (`provider`) and the given sizing. */
function clusterNode(
	provider: CloudProviderSlug | null,
	sizing: { instance_types?: string[]; node_size?: NodeSize },
): CanvasNode<"cluster"> {
	return {
		id: CLUSTER_ID,
		type: "cluster",
		position: { x: 0, y: 0 },
		data: {
			kind: "cluster",
			config: { cluster_version: "1.33", ...sizing },
			cloud_identity_id: null,
			provider,
		},
	};
}

/** Replace the store's graph with `nodes`, as a seeded workbench would. */
function seed(nodes: CanvasNode[]) {
	useCanvasStore.setState({
		nodes,
		baseline: structuredClone(nodes),
		past: [],
		future: [],
		dirty: false,
	});
}

/** The cluster's sizing as the store currently holds it. */
function clusterSizing() {
	const node = useCanvasStore.getState().nodes.find((n) => n.id === CLUSTER_ID);
	return node?.data.kind === "cluster"
		? { instance_types: node.data.config.instance_types, node_size: node.data.config.node_size }
		: undefined;
}

beforeEach(() => {
	useCanvasStore.getState().reset();
});

describe("a cluster moved to another cloud keeps a machine that cloud has (#5269)", () => {
	it("maps a pinned type through the catalog's equivalence, with no notice", () => {
		seed([projectNode("aws"), clusterNode("aws", { instance_types: ["t3.large"] })]);
		const notices = useCanvasStore.getState().setNodeIdentity(CLUSTER_ID, "ci-gcp", "gcp");
		expect(clusterSizing()?.instance_types).toEqual(["e2-standard-2"]);
		expect(notices).toEqual([]);
	});

	it("falls back to the target's default and SAYS so when there is no equivalent", () => {
		// m6i.large is a real AWS type the seed data pins, and the catalog maps nothing for it.
		seed([projectNode("aws"), clusterNode("aws", { instance_types: ["m6i.large"] })]);
		const notices = useCanvasStore.getState().setNodeIdentity(CLUSTER_ID, "ci-azure", "azure");
		expect(clusterSizing()?.instance_types).toEqual(["Standard_D2s_v5"]);
		expect(notices).toHaveLength(1);
		expect(notices[0]?.message).toMatch(/m6i\.large.*Standard_D2s_v5/);
	});

	it("moves an INHERITING cluster when the project root changes cloud", () => {
		seed([projectNode("aws"), clusterNode(null, { instance_types: ["t3.xlarge"] })]);
		useCanvasStore.getState().setNodeIdentity(PROJECT_NODE_ID, "ci-gcp", "gcp");
		expect(clusterSizing()?.instance_types).toEqual(["e2-standard-4"]);
	});

	it("leaves a node_size cluster alone — it re-resolves on the new cloud by itself", () => {
		seed([
			projectNode("aws"),
			clusterNode("aws", { instance_types: [], node_size: { vcpu: 4, memory_gb: 16 } }),
		]);
		const notices = useCanvasStore.getState().setNodeIdentity(CLUSTER_ID, "ci-gcp", "gcp");
		expect(clusterSizing()).toEqual({ instance_types: [], node_size: { vcpu: 4, memory_gb: 16 } });
		expect(notices).toEqual([]);
	});

	it("changes nothing when the identity moves within the same cloud", () => {
		seed([projectNode("aws"), clusterNode("aws", { instance_types: ["m6i.large"] })]);
		const notices = useCanvasStore.getState().setNodeIdentity(CLUSTER_ID, "ci-aws-2", "aws");
		expect(clusterSizing()?.instance_types).toEqual(["m6i.large"]);
		expect(notices).toEqual([]);
	});
});
