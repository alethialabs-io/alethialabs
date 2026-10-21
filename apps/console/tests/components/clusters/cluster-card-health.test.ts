// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6122: a cluster card's posture is derived. Every card is a running cluster, so a run in flight
// reads as in flight, and a failed last run is said on the rollup without calling a running cluster
// failed. Otherwise the cluster and its data services roll up as before.

import { describe, expect, it } from "vitest";
import { deriveHealth } from "@/components/clusters/cluster-card";

describe("deriveHealth", () => {
	it("a failed last run on a running cluster says the run failed — not that the cluster did", () => {
		const h = deriveHealth("ACTIVE", "FAILED", ["ACTIVE"]);
		expect([h.tier, h.name]).toEqual(["active", "Active"]);
		expect([h.rollupTier, h.rollup]).toEqual(["failed", "Last run failed"]);
	});

	it("a deploy in flight is pending, named for the environment's verb", () => {
		const h = deriveHealth("PENDING", "PROVISIONING", []);
		expect([h.tier, h.name, h.rollup]).toEqual(["pending", "Provisioning", "Provisioning"]);
		expect(deriveHealth("PENDING", "QUEUED", []).name).toBe("Queued");
	});

	it("a teardown in flight says so", () => {
		const h = deriveHealth("ACTIVE", "DESTROYING", ["ACTIVE"]);
		expect([h.tier, h.rollup]).toEqual(["pending", "Tearing down"]);
	});

	it("a settled environment rolls up the cluster and its data services", () => {
		expect(deriveHealth("ACTIVE", "ACTIVE", ["ACTIVE", "ACTIVE"])).toMatchObject({
			tier: "active",
			name: "Active",
			detail: "3 / 3 healthy",
		});
		expect(deriveHealth("ACTIVE", "ACTIVE", ["FAILED"])).toMatchObject({ tier: "failed", name: "Degraded" });
		expect(deriveHealth("UPDATING", "ACTIVE", [])).toMatchObject({ tier: "pending", name: "Updating" });
	});

	it("a plan's DRAFT environment over a live cluster reads from the cluster, not as draft", () => {
		expect(deriveHealth("ACTIVE", "DRAFT", [])).toMatchObject({ tier: "active", name: "Active" });
	});
});
