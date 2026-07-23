// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// Azure service-quota lane (#981): the pure normalizer over the Microsoft.Network usages response. Azure
// reports current + limit, so used/available are populated; NAT gateways are absent from this endpoint.

import { describe, expect, it } from "vitest";
import type { CapabilityIdentity } from "@/lib/cloud-providers/capabilities/types";
import {
	normalizeAzureNetworkUsages,
	syncAzureQuotaCapabilities,
} from "@/lib/cloud-providers/capabilities/service-quotas/azure";

describe("normalizeAzureNetworkUsages", () => {
	// Recorded Microsoft.Network/locations/usages `value[]` shape.
	const usages = [
		{
			name: { value: "PublicIPAddresses", localizedValue: "Public IP Addresses" },
			currentValue: 8,
			limit: 60,
		},
		{
			name: { value: "LoadBalancers", localizedValue: "Load Balancers" },
			currentValue: 2,
			limit: 1000,
		},
		{
			name: { value: "NetworkSecurityGroups", localizedValue: "Network Security Groups" },
			currentValue: 5,
			limit: 5000,
		},
		{ name: { value: "VirtualNetworks" }, currentValue: 1, limit: 1000 }, // unrelated → ignored
	];

	it("maps the tracked networking usages, computing available = limit - used", () => {
		const rows = normalizeAzureNetworkUsages("eastus", usages);
		expect(rows.map((r) => r.quota_kind).sort()).toEqual([
			"elastic_ip",
			"load_balancer",
			"security_group",
		]);
		const eip = rows.find((r) => r.quota_kind === "elastic_ip");
		expect(eip?.native_id).toBe("PublicIPAddresses");
		expect(eip?.quota_limit).toBe(60);
		expect(eip?.used).toBe(8);
		expect(eip?.available).toBe(52);
		expect(eip?.region).toBe("eastus");
	});

	it("leaves available NULL when a figure is missing", () => {
		const rows = normalizeAzureNetworkUsages("eastus", [
			{ name: { value: "PublicIPAddresses" }, limit: 60 },
		]);
		expect(rows[0].used).toBeNull();
		expect(rows[0].available).toBeNull();
		expect(rows[0].quota_limit).toBe(60);
	});

	it("ignores usages without a recognized name", () => {
		expect(normalizeAzureNetworkUsages("eastus", [{ currentValue: 1, limit: 2 }])).toEqual([]);
	});
});

describe("syncAzureQuotaCapabilities (best-effort guard)", () => {
	it("returns without throwing when Azure credentials are absent", async () => {
		const identity: CapabilityIdentity = {
			id: "id-1",
			provider: "azure",
			credentials: {},
		};
		await expect(syncAzureQuotaCapabilities(identity)).resolves.toBeUndefined();
	});
});
