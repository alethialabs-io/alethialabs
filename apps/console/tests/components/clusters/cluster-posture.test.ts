// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6122: a cluster's posture is derived. Every row is a running cluster, so a run in flight
// reads as in flight, and a failed last run is said on the rollup without calling a running cluster
// failed. Otherwise the cluster and its data services roll up as before.

import { describe, expect, it } from "vitest";
import {
	type Observed,
	clusterPosture,
	clusterStatusKey,
	controlPlaneBadge,
	deriveHealth,
	offersMissingActions,
} from "@/components/clusters/cluster-posture";

describe("deriveHealth", () => {
	it("a failed last run on a running cluster says the run failed — not that the cluster did", () => {
		const h = deriveHealth("ACTIVE", "FAILED", ["ACTIVE"]);
		expect([h.tier, h.name]).toEqual(["active", "Active"]);
		expect([h.rollupTier, h.rollup]).toEqual(["failed", "Last run failed"]);
	});

	it("a deploy in flight is pending, in the console's words for it", () => {
		const h = deriveHealth("PENDING", "PROVISIONING", []);
		expect([h.tier, h.name, h.rollup]).toEqual(["pending", "Deploying", "Deploying"]);
		expect(deriveHealth("PENDING", "QUEUED", []).name).toBe("Queued");
	});

	it("a destroy in flight says so", () => {
		const h = deriveHealth("ACTIVE", "DESTROYING", ["ACTIVE"]);
		expect([h.tier, h.name, h.rollup]).toEqual(["pending", "Destroying", "Destroying"]);
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
		expect([h.tier, h.name]).toEqual(["pending", "Deploying"]);
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

// #6819: the status a cluster is FILTERED under is one of four, derived from the same posture the
// row shows, so a chip and the rows it selects cannot disagree.
describe("clusterStatusKey", () => {
	/** A row with the fields a posture is derived from. */
	function row(envStatus: string, clusterStatus = "ACTIVE", services: string[] = []) {
		return {
			status: envStatus,
			status_since: "2026-11-01T00:00:00.000Z",
			environment_id: "e1",
			project_cluster: {
				status: clusterStatus,
				observation: { kind: "reported" as const, observedAt: "2026-11-01T00:00:00.000Z", source: "deploy" as const, fresh: true },
			},
			project_databases: services.map((status) => ({ status })),
			project_caches: [],
		};
	}

	it("a healthy cluster is active", () => {
		expect(clusterStatusKey(clusterPosture(row("ACTIVE")))).toBe("active");
	});

	it("a failed LAST RUN over a running cluster needs attention, though the cluster reads Active", () => {
		const posture = clusterPosture(row("FAILED"));
		expect(posture.name).toBe("Active");
		expect(clusterStatusKey(posture)).toBe("failed");
	});

	it("a failed data service needs attention", () => {
		expect(clusterStatusKey(clusterPosture(row("ACTIVE", "ACTIVE", ["FAILED"])))).toBe("failed");
	});

	it("a run in flight is pending", () => {
		expect(clusterStatusKey(clusterPosture(row("PROVISIONING")))).toBe("pending");
		expect(clusterStatusKey(clusterPosture(row("DESTROYING")))).toBe("pending");
	});

	it("an ACTIVE nothing has observed recently is idle — never counted healthy", () => {
		const stale = row("ACTIVE");
		const posture = clusterPosture({
			...stale,
			project_cluster: {
				status: "ACTIVE",
				observation: { kind: "reported", observedAt: "2026-07-16T00:00:00.000Z", source: "deploy", fresh: false },
			},
		});
		expect(clusterStatusKey(posture)).toBe("idle");
	});
});

describe("offersMissingActions", () => {
	const missing = {
		kind: "missing" as const,
		source: "drift" as const,
		observedAt: "2026-11-09T00:00:00.000Z",
		deleted: ["azurerm_kubernetes_cluster.main"],
	};

	it("offers them for a cluster observed missing with no run in flight", () => {
		expect(offersMissingActions({ status: "ACTIVE", environment_id: "e1", project_cluster: { observation: missing } })).toBe(true);
	});

	it("does not while a run is in flight, or without an environment to act on", () => {
		expect(offersMissingActions({ status: "PROVISIONING", environment_id: "e1", project_cluster: { observation: missing } })).toBe(false);
		expect(offersMissingActions({ status: "ACTIVE", environment_id: null, project_cluster: { observation: missing } })).toBe(false);
	});
});
