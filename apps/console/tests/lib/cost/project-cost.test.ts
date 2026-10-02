// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// lib/cost/project-cost.ts → estimateProjectCost, the artifact panel's estimate (#5361). The
// cluster is priced on its OWN cloud (getProject's `clusterCloudProvider`), the project-wide lines
// on the project's; and the machine the estimate names is the one the cluster card shows on that
// same cloud.

import { describe, expect, it } from "vitest";
import { NODE_REGISTRY } from "@/components/design-project/canvas/graph/node-registry";
import { getProvider } from "@/lib/cloud-providers/provider-slug";
import { type ProjectCostSource, estimateProjectCost } from "@/lib/cost/project-cost";

const SIZE = { vcpu: 4, memory_gb: 16 };

/** A project with one node_size-sized cluster and one secret, on the given clouds. */
function detail(cloudProvider: string, clusterCloudProvider: string): ProjectCostSource {
	return {
		cloudProvider,
		clusterCloudProvider,
		components: {
			cluster: { instance_types: [], node_size: SIZE, capacity_type: null, node_desired_size: 1 },
			network: null,
			dns: null,
			databases: [],
			caches: [],
			nosql_tables: [],
			secrets: [{}],
		},
	};
}

/** The node line of an estimate. */
const nodesOf = (r: ReturnType<typeof estimateProjectCost>) =>
	r.items.find((i) => i.label.endsWith("Nodes"));

describe("estimateProjectCost prices the cluster on its own cloud (#5361)", () => {
	it("a gcp-identity cluster in an aws project is priced at gcp rates with a gcp SKU", () => {
		const r = estimateProjectCost(detail("aws", "gcp"), null);
		const nodes = nodesOf(r);
		expect(nodes?.label).toBe("GKE Nodes");
		expect(nodes?.detail).toBe("1x 4 vCPU / 16 GB → e2-standard-4");
		// e2-standard-4's catalog hint is ~$98/mo.
		expect(Math.round(nodes?.cost ?? 0)).toBe(98);
		expect(r.items.some((i) => i.label === "GKE Control Plane")).toBe(true);
		// The project-wide secrets line stays on the project's cloud.
		expect(r.items.some((i) => i.label === getProvider("aws").secretsService)).toBe(true);
	});

	it("a cluster without its own identity is priced on the project's cloud", () => {
		const nodes = nodesOf(estimateProjectCost(detail("aws", "aws"), null));
		expect(nodes?.label).toBe("EKS Nodes");
		expect(nodes?.detail).toBe("1x 4 vCPU / 16 GB → t3.xlarge");
	});

	it("the estimate names the machine the cluster card shows on the cluster's cloud", () => {
		const facts = NODE_REGISTRY.cluster.card.facts({
			config: { ...NODE_REGISTRY.cluster.defaultData("gcp"), instance_types: [], node_size: SIZE },
			provider: "gcp",
		});
		const shape = facts.find((f) => f.label === "Shape")?.value ?? "";
		expect(nodesOf(estimateProjectCost(detail("aws", "gcp"), null))?.detail).toBe(`1x ${shape}`);
	});
});
