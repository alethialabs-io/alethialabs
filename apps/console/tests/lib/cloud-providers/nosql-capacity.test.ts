// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #4320, maintainer ruling 2026-09-23: Azure Cosmos DB is serverless only. The catalog no longer
// offers "Provisioned Throughput" on Azure, and rows saved as `provisioned` before the ruling are
// normalised at READ time — the Capacity mode card, the node card, the sheet summary, the canvas
// store's staged change, the deploy snapshot and a cloud conversion all ask `effectiveCapacityMode`.
// These pin that one function, plus the inspector, where a regression is what a user would see.

import { describe, expect, it } from "vitest";

import { getKindConfig, NO_CAPABILITIES, type FieldCtx } from "@/components/design-project/canvas/inspector/config-schema";
import { type CloudProviderSlug, NOSQL } from "@/lib/cloud-providers/generated/catalog";
import {
	effectiveCapacityMode,
	effectiveCapacityModeForCloud,
	normalizeCapacityMode,
	type NosqlCapacityMode,
} from "@/lib/cloud-providers/nosql-capacity";

/** A one-field nosql config, typed through the enum rather than asserted. */
const row = (capacity_mode: NosqlCapacityMode): { capacity_mode: NosqlCapacityMode } => ({ capacity_mode });

describe("the catalog", () => {
	it("offers Azure serverless only", () => {
		expect(NOSQL.azure.billingModes.map((m) => m.value)).toEqual(["on_demand"]);
	});

	it("still offers provisioned where it is real — the enum column is shared", () => {
		expect(NOSQL.aws.billingModes.map((m) => m.value)).toContain("provisioned");
		expect(NOSQL.alibaba.billingModes.map((m) => m.value)).toContain("provisioned");
	});
});

describe("effectiveCapacityMode", () => {
	it("reads a legacy Azure `provisioned` row as on_demand", () => {
		expect(effectiveCapacityMode("azure", "provisioned")).toBe("on_demand");
	});

	it("leaves a mode the cloud offers alone", () => {
		expect(effectiveCapacityMode("aws", "provisioned")).toBe("provisioned");
		expect(effectiveCapacityMode("azure", "on_demand")).toBe("on_demand");
	});

	it("does not rewrite while no cloud is known, or where the catalog lists no modes", () => {
		expect(effectiveCapacityMode(null, "provisioned")).toBe("provisioned");
		// Hetzner's in-cluster ScyllaDB lists none: "capacity means nothing here", not "on-demand".
		expect(effectiveCapacityMode("hetzner", "provisioned")).toBe("provisioned");
	});

	it("passes an absent value through", () => {
		expect(effectiveCapacityMode("azure", null)).toBeNull();
		expect(effectiveCapacityMode("azure", undefined)).toBeUndefined();
	});

	it("takes the raw cloud_provider string server-side, passing connect-only clouds through", () => {
		expect(effectiveCapacityModeForCloud("azure", "provisioned")).toBe("on_demand");
		expect(effectiveCapacityModeForCloud("digitalocean", "provisioned")).toBe("provisioned");
	});
});

describe("normalizeCapacityMode", () => {
	it("rewrites a legacy Azure row", () => {
		expect(normalizeCapacityMode(row("provisioned"), "azure").capacity_mode).toBe("on_demand");
	});

	it("returns the SAME object when nothing changes, so a clean project does not open dirty", () => {
		const aws = row("provisioned");
		expect(normalizeCapacityMode(aws, "aws")).toBe(aws);
		const azure = row("on_demand");
		expect(normalizeCapacityMode(azure, "azure")).toBe(azure);
	});
});

describe("the inspector", () => {
	const field = getKindConfig("nosql")
		?.sections.flatMap((s) => s.fields)
		.find((f) => f.key === "capacity_mode");

	/** The values the Capacity mode card offers on a cloud. */
	const offered = (provider: CloudProviderSlug) => {
		const config: Record<string, unknown> = {};
		const ctx: FieldCtx = { provider, config, caps: NO_CAPABILITIES };
		const opts = typeof field?.options === "function" ? field.options(ctx) : field?.options;
		return (opts ?? []).map((o) => o.value);
	};

	it("no longer offers provisioned capacity on Azure", () => {
		expect(field).toBeDefined();
		expect(offered("azure")).toEqual(["on_demand"]);
		expect(offered("aws")).toEqual(["on_demand", "provisioned"]);
	});

	it("summarises a legacy Azure row as what it gets", () => {
		expect(getKindConfig("nosql")?.summary({ partition_key: "id", capacity_mode: "provisioned" }, "azure")).toBe(
			"id · On-demand",
		);
		expect(getKindConfig("nosql")?.summary({ partition_key: "id", capacity_mode: "provisioned" }, "aws")).toBe(
			"id · Provisioned",
		);
	});
});
