// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #5291: the cluster card and the cost estimate must name the SAME machine. Both are meant to read
// it from node-sizing.ts → resolveInstanceTypes; this ranges over every provisioning cloud and a
// grid of sizing rows (size only, pin only, a legacy row holding both) and requires the card's
// Shape fact AND the estimate's node line to carry exactly resolveInstanceTypes' first answer. A
// second resolver on either side — or one side reading instance_types alone — fails here.

import { describe, expect, it } from "vitest";
import { NODE_REGISTRY } from "@/components/design-project/canvas/graph/node-registry";
import { resolveInstanceTypes, type ClusterSizing } from "@/lib/cloud-providers/node-sizing";
import { CLOUD_PROVIDER_SLUGS } from "@/lib/cloud-providers/provider-slug";
import { computeCostItems } from "@/lib/cost/compute-cost-items";

const SIZES = [
	{ vcpu: 2, memory_gb: 4 },
	{ vcpu: 4, memory_gb: 16 },
	{ vcpu: 8, memory_gb: 32 },
	{ vcpu: 16, memory_gb: 64 },
];

/** The sizing rows worth asking about on one cloud. */
function rows(pin: string): Array<{ name: string; sizing: ClusterSizing }> {
	return [
		...SIZES.map((s) => ({ name: `size ${s.vcpu}x${s.memory_gb}`, sizing: { instance_types: [], node_size: s } })),
		{ name: `pin ${pin}`, sizing: { instance_types: [pin], node_size: null } },
		{ name: `legacy both (${pin} + 8x32)`, sizing: { instance_types: [pin], node_size: { vcpu: 8, memory_gb: 32 } } },
	];
}

/** The machine a rendered shape names: the SKU after `→`, or the whole text for a pinned type. */
function machineIn(text: string): string {
	const arrow = text.lastIndexOf("→ ");
	return arrow >= 0 ? text.slice(arrow + 2) : text;
}

describe("the cluster card and the cost estimate name the same machine", () => {
	for (const provider of CLOUD_PROVIDER_SLUGS) {
		const base = NODE_REGISTRY.cluster.defaultData(provider);
		const pin = base.instance_types?.[0] ?? "";
		it.each(rows(pin))(`${provider}: %s`, ({ sizing }) => {
			const [expected] = resolveInstanceTypes(provider, sizing);
			expect(expected, "every catalog cloud resolves these rows").toBeTruthy();

			const facts = NODE_REGISTRY.cluster.card.facts({ config: { ...base, instance_types: sizing.instance_types, node_size: sizing.node_size ?? undefined }, provider });
			const shape = facts.find((f) => f.label === "Shape")?.value ?? "";
			expect(machineIn(shape)).toBe(expected);

			const { items } = computeCostItems(
				{
					instanceTypes: sizing.instance_types ?? [],
					nodeSize: sizing.node_size,
					nodeDesiredSize: 1,
					singleNatGateway: true,
					databases: [],
					caches: [],
					cloudfrontWaf: false,
					applicationWaf: false,
					nosqlCount: 0,
					secretsCount: 0,
				},
				null,
				{ clusterService: "K8s", secretsService: "Secrets", provider },
			);
			const detail = items.find((i) => i.label === "K8s Nodes")?.detail ?? "";
			expect(machineIn(detail.replace(/^1x /, ""))).toBe(expected);
		});
	}
});
