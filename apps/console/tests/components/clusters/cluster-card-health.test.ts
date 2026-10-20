// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6122: a cluster card's posture is derived, and the ENVIRONMENT speaks first — a failed deploy
// must read as failed even while the cluster row still says PENDING, and a deploy or teardown in
// flight reads as in flight. Otherwise the cluster and its data services roll up as before.

import { describe, expect, it } from "vitest";
import { deriveHealth } from "@/components/clusters/cluster-card";

describe("deriveHealth", () => {
	it("a failed environment is failed, whatever its rows say", () => {
		const h = deriveHealth("PENDING", "FAILED", []);
		expect([h.tier, h.name, h.rollup]).toEqual(["failed", "Failed", "Last run failed"]);
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
