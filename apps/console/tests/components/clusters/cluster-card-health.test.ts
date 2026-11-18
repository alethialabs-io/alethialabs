// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6122: a cluster card's posture is derived. Every card is a running cluster, so a run in flight
// reads as in flight, and a failed last run is said on the rollup without calling a running cluster
// failed. Otherwise the cluster and its data services roll up as before.

import { describe, expect, it } from "vitest";
import { controlPlaneBadge, deriveHealth, type Observed } from "@/components/clusters/cluster-card";

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

// #6736: the card never claims "healthy" or "ACTIVE" without a fresh reading, and says "Missing" when a
// drift scan since the deploy reports the control plane deleted.
describe("deriveHealth — what has been observed", () => {
	const SCAN = "2026-11-09T00:00:00.000Z";
	const missing: Observed = {
		observation: { kind: "missing", source: "drift", observedAt: SCAN, deleted: ["azurerm_resource_group.main"] },
		statusSince: "2026-07-16T00:00:00.000Z",
	};
	const stale: Observed = {
		observation: { kind: "reported", observedAt: "2026-07-16T00:00:00.000Z", source: "deploy", fresh: false },
		statusSince: "2026-07-16T00:00:00.000Z",
	};

	it("a run stuck in flight since BEFORE the scan that found the cluster deleted reads Missing, with 0 healthy (the a640 card)", () => {
		const h = deriveHealth("ACTIVE", "PROVISIONING", [], missing);
		expect([h.tier, h.name, h.rollup, h.detail]).toEqual(["failed", "Missing", "Deleted outside Alethia", "0 / 1 healthy"]);
	});

	it("a run started AFTER that scan is what is happening to the cluster: it reads in flight", () => {
		const h = deriveHealth("ACTIVE", "PROVISIONING", [], { ...missing, statusSince: "2026-11-10T00:00:00.000Z" });
		expect([h.tier, h.name]).toEqual(["pending", "Provisioning"]);
	});

	it("an ACTIVE nobody has observed recently is Unverified, never Healthy", () => {
		const h = deriveHealth("ACTIVE", "ACTIVE", [], stale);
		expect([h.tier, h.name, h.rollup, h.detail]).toEqual(["idle", "Unverified", "Not observed recently", "0 / 1 healthy"]);
	});

	it("an unreachable probe reads Unreachable", () => {
		const h = deriveHealth("ACTIVE", "ACTIVE", ["ACTIVE"], {
			observation: { kind: "unreachable", observedAt: SCAN, message: null },
			statusSince: SCAN,
		});
		expect([h.tier, h.name, h.detail]).toEqual(["failed", "Unreachable", "1 / 2 healthy"]);
	});

	it("the control-plane row says the same thing as the posture", () => {
		expect(controlPlaneBadge("ACTIVE", missing.observation)).toEqual({ tier: "failed", label: "Missing" });
		expect(controlPlaneBadge("ACTIVE", stale.observation)).toEqual({ tier: "idle", label: "Unverified" });
		expect(controlPlaneBadge("UPDATING", stale.observation)).toEqual({ tier: "pending", label: "Updating" });
	});
});
