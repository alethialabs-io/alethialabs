// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The console's single answer to "what machine does this cluster get" (#5267): Go's precedence
// (a pinned instance_types wins, else node_size resolves), the card's text, and the one-writer rule
// the CLI applies. Expected SKUs are fixed BY DECISION from catalog.json's inventory — recomputing
// them with nearestInstance would pass on any answer.

import { describe, expect, it } from "vitest";
import {
	applySizingOneWriter,
	describeNodeShape,
	resolveInstanceTypes,
} from "@/lib/cloud-providers/node-sizing";

describe("resolveInstanceTypes", () => {
	it("resolves node_size to the nearest general SKU on the cluster's cloud", () => {
		const size = { vcpu: 4, memory_gb: 16 };
		expect(resolveInstanceTypes("gcp", { node_size: size })).toEqual(["e2-standard-4"]);
		expect(resolveInstanceTypes("aws", { node_size: size, instance_types: [] })).toEqual(["t3.xlarge"]);
	});

	it("lets a pinned instance type win, as Go does — a legacy row holding both deploys the pin", () => {
		expect(
			resolveInstanceTypes("gcp", {
				instance_types: ["n2-standard-2"],
				node_size: { vcpu: 8, memory_gb: 32 },
			}),
		).toEqual(["n2-standard-2"]);
	});

	it("answers nothing with no size, or no cloud to resolve against", () => {
		expect(resolveInstanceTypes("gcp", {})).toEqual([]);
		expect(resolveInstanceTypes(null, { node_size: { vcpu: 2, memory_gb: 8 } })).toEqual([]);
	});
});

describe("describeNodeShape — the cluster card's Shape", () => {
	it("shows the size AND the SKU it resolves to", () => {
		expect(describeNodeShape("gcp", { instance_types: [], node_size: { vcpu: 4, memory_gb: 16 } })).toBe(
			"4 vCPU / 16 GB → e2-standard-4",
		);
	});

	it("shows the pinned type for a row holding both, because that is what deploys", () => {
		expect(
			describeNodeShape("gcp", { instance_types: ["n2-standard-2"], node_size: { vcpu: 8, memory_gb: 32 } }),
		).toBe("n2-standard-2");
	});

	it("shows the size alone when the node has no cloud yet, and nothing when unsized", () => {
		expect(describeNodeShape(null, { node_size: { vcpu: 2, memory_gb: 8 } })).toBe("2 vCPU / 8 GB");
		expect(describeNodeShape("aws", {})).toBe("");
	});
});

describe("applySizingOneWriter", () => {
	it("clears instance_types when node_size is set", () => {
		expect(applySizingOneWriter({ node_size: { vcpu: 2, memory_gb: 8 } })).toEqual({
			ok: true,
			values: { node_size: { vcpu: 2, memory_gb: 8 }, instance_types: [] },
		});
	});

	it("clears node_size when a machine type is pinned", () => {
		expect(applySizingOneWriter({ instance_types: ["t3.large"] })).toEqual({
			ok: true,
			values: { instance_types: ["t3.large"], node_size: null },
		});
	});

	it("refuses both at once, and passes a write naming neither untouched", () => {
		expect(
			applySizingOneWriter({ node_size: { vcpu: 2, memory_gb: 8 }, instance_types: ["t3.large"] }).ok,
		).toBe(false);
		expect(applySizingOneWriter({ node_min_size: 3 })).toEqual({ ok: true, values: { node_min_size: 3 } });
		expect(applySizingOneWriter({ instance_types: [] })).toEqual({ ok: true, values: { instance_types: [] } });
	});
});
