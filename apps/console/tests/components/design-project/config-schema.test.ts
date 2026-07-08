// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The inspector's field engine is generic over each kind's config type, so the per-kind
// summary/get/set closures read typed config (no casts). These pin the runtime output of
// those closures — the payoff must behave exactly as before the typing sweep.

import { describe, expect, it } from "vitest";
import {
	CONFIG_SCHEMA,
	getKindConfig,
} from "@/components/design-project/canvas/inspector/config-schema";
import { ADDABLE_KINDS } from "@/components/design-project/canvas/graph/node-registry";

describe("getKindConfig", () => {
	it("resolves a schema for every addable kind", () => {
		for (const kind of ADDABLE_KINDS) {
			expect(getKindConfig(kind)).toBe(CONFIG_SCHEMA[kind]);
			expect(getKindConfig(kind)?.summary).toBeTypeOf("function");
		}
	});
});

describe("kind summaries", () => {
	const summary = (kind: Parameters<typeof getKindConfig>[0], config: object) =>
		getKindConfig(kind)?.summary(config as Record<string, unknown>, null);

	it("renders each kind's header line from typed config", () => {
		expect(summary("project", { project_name: "My App" })).toBe("My App");
		expect(
			summary("database", {
				engine_family: "postgres",
				min_capacity: 0.5,
				max_capacity: 4,
			}),
		).toBe("PostgreSQL · 0.5–4");
		expect(
			summary("cluster", {
				cluster_version: "1.30",
				node_min_size: 2,
				node_max_size: 5,
			}),
		).toBe("k8s 1.30 · 2–5 nodes");
		expect(summary("cache", { engine: "valkey", node_type: "cache.t3.micro" })).toBe(
			"Valkey · cache.t3.micro",
		);
		expect(summary("network", { provision_network: false, network_id: "vpc-1" })).toBe(
			"vpc-1",
		);
	});
});

describe("field get/set escape hatches", () => {
	it("reads and writes the cluster instance type through the first array slot", () => {
		const field = getKindConfig("cluster")
			?.sections.flatMap((s) => s.fields)
			.find((f) => f.key === "instance_types");
		expect(field?.get?.({ instance_types: ["m5.large"] })).toBe("m5.large");
		expect(field?.set?.("m5.xlarge", {})).toEqual({ instance_types: ["m5.xlarge"] });
	});
});
