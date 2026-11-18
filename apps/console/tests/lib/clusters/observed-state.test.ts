// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// #6736: what the console may claim about a control plane, from its last successful deploy, its
// latest drift scan and its latest probe. The production case that motivated it: an AKS cluster
// whose deploy recorded ACTIVE four months earlier, while a drift scan seven days ago reported its
// resource group deleted — and the card said "healthy".

import { describe, expect, it } from "vitest";
import {
	deletedControlPlaneResources,
	freshnessWindowMs,
	observationWire,
	observeControlPlane,
} from "@/lib/clusters/observed-state";
import type { DriftDetail } from "@/types/jsonb.types";

const NOW = new Date("2026-11-16T12:00:00Z");
const DEPLOYED = "2026-07-16T12:00:00.000Z";

/** A drift detail of `type` diverged as `kind`. */
function detail(type: string, kind: DriftDetail["kind"], name = "main"): DriftDetail {
	return { address: `${type}.${name}`, type, kind };
}

describe("deletedControlPlaneResources", () => {
	it("names the cluster resource and the Azure resource group that holds it", () => {
		expect(
			deletedControlPlaneResources([
				detail("azurerm_resource_group", "deleted"),
				detail("azurerm_federated_identity_credential", "deleted"),
				detail("azurerm_kubernetes_cluster", "deleted"),
			]),
		).toEqual(["azurerm_resource_group.main", "azurerm_kubernetes_cluster.main"]);
	});

	it("is an exact type match: a node pool or an addon going missing is drift, not a missing control plane", () => {
		expect(
			deletedControlPlaneResources([
				detail("azurerm_kubernetes_cluster_node_pool", "deleted"),
				detail("aws_eks_addon", "deleted"),
			]),
		).toEqual([]);
	});

	it("only a deletion counts — a modified cluster is still there", () => {
		expect(deletedControlPlaneResources([detail("aws_eks_cluster", "modified")])).toEqual([]);
		expect(deletedControlPlaneResources(null)).toEqual([]);
	});
});

describe("observeControlPlane", () => {
	it("a drift scan since the deploy reporting the resource group deleted reads as missing (the a640 case)", () => {
		const o = observeControlPlane({
			lastDeployedAt: DEPLOYED,
			stage: "development",
			drift: { scannedAt: "2026-11-09T12:00:00.000Z", details: [detail("azurerm_resource_group", "deleted")] },
			probe: null,
			now: NOW,
		});
		expect(o).toEqual({
			kind: "missing",
			source: "drift",
			observedAt: "2026-11-09T12:00:00.000Z",
			deleted: ["azurerm_resource_group.main"],
		});
	});

	it("ignores a scan older than the last deploy: the deploy recreated what it found gone", () => {
		const o = observeControlPlane({
			lastDeployedAt: DEPLOYED,
			stage: "development",
			drift: { scannedAt: "2026-07-01T00:00:00.000Z", details: [detail("aws_eks_cluster", "deleted")] },
			probe: null,
			now: NOW,
		});
		expect(o.kind).toBe("reported");
	});

	it("a probe since the deploy that could not reach it reads as unreachable", () => {
		const o = observeControlPlane({
			lastDeployedAt: DEPLOYED,
			stage: "production",
			drift: null,
			probe: { reachable: false, probedAt: "2026-11-16T11:55:00.000Z", message: "dial timeout" },
			now: NOW,
		});
		expect(o).toEqual({ kind: "unreachable", observedAt: "2026-11-16T11:55:00.000Z", message: "dial timeout" });
	});

	it("a deploy four months old, with nothing since, is reported but NOT fresh", () => {
		const o = observeControlPlane({ lastDeployedAt: DEPLOYED, stage: "development", drift: null, probe: null, now: NOW });
		expect(o).toEqual({ kind: "reported", observedAt: DEPLOYED, source: "deploy", fresh: false });
	});

	it("a recent reachable probe is the reading that backs the status, and it is fresh", () => {
		const o = observeControlPlane({
			lastDeployedAt: DEPLOYED,
			stage: "production",
			drift: { scannedAt: "2026-11-16T06:00:00.000Z", details: [detail("aws_db_instance", "modified")] },
			probe: { reachable: true, probedAt: "2026-11-16T11:55:00.000Z", message: null },
			now: NOW,
		});
		expect(o).toEqual({ kind: "reported", observedAt: "2026-11-16T11:55:00.000Z", source: "probe", fresh: true });
	});

	it("freshness is two probe intervals for the tier: a 30-minute-old prod reading is already stale", () => {
		expect(freshnessWindowMs("production")).toBe(20 * 60_000);
		expect(freshnessWindowMs("development")).toBe(12 * 3_600_000);
		const o = observeControlPlane({
			lastDeployedAt: "2026-11-16T11:30:00.000Z",
			stage: "production",
			drift: null,
			probe: null,
			now: NOW,
		});
		expect(o).toMatchObject({ kind: "reported", fresh: false });
	});

	it("a cluster never deployed has nothing observed", () => {
		const o = observeControlPlane({ lastDeployedAt: null, stage: null, drift: null, probe: null, now: NOW });
		expect(o).toEqual({ kind: "reported", observedAt: null, source: "deploy", fresh: false });
	});

	it("a probe the cloud answered 'not found' reads as missing, timed by the probe", () => {
		const o = observeControlPlane({
			lastDeployedAt: DEPLOYED,
			stage: "development",
			drift: null,
			probe: { reachable: false, probedAt: "2026-11-16T06:00:00.000Z", message: "cluster not found", gone: true },
			now: NOW,
		});
		expect(o).toEqual({ kind: "missing", source: "probe", observedAt: "2026-11-16T06:00:00.000Z", deleted: [] });
	});

	it("a probe that REACHED the cluster after the scan that found it deleted outranks the scan", () => {
		const o = observeControlPlane({
			lastDeployedAt: DEPLOYED,
			stage: "development",
			drift: { scannedAt: "2026-11-09T12:00:00.000Z", details: [detail("azurerm_resource_group", "deleted")] },
			probe: { reachable: true, probedAt: "2026-11-16T06:00:00.000Z", message: null },
			now: NOW,
		});
		expect(o).toMatchObject({ kind: "reported", source: "probe" });
	});
});

describe("observationWire", () => {
	it("flattens each kind into the word the CLI prints", () => {
		expect(
			observationWire({ kind: "missing", source: "drift", observedAt: "t", deleted: ["azurerm_resource_group.main"] }),
		).toEqual({ state: "missing", observed_at: "t", source: "drift", detail: "deleted: azurerm_resource_group.main" });
		expect(observationWire({ kind: "reported", observedAt: "t", source: "deploy", fresh: false }).state).toBe(
			"unverified",
		);
		expect(observationWire({ kind: "reported", observedAt: null, source: "deploy", fresh: false }).state).toBe(
			"never_observed",
		);
	});
});
