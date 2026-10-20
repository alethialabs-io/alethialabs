// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The cloud-provider store, split (#6119, ADR 0005 D5): the SELECTION (provider + identity) is UI
// state in Zustand; the identity's live inventory is the `canvas.cloudInventory` GET procedure read
// through the query cache. AWS/GCP/Azure/Alibaba read the normalized server-side inventory and adapt
// it to the legacy per-provider cached shape — Alibaba's VPC/VSwitch rows are upserted AWS-shaped, so
// it maps through the AWS adapter. Token clouds (Hetzner) have no VPCs: no read, no resources.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeCall, FakeHandler } from "@/tests/helpers/fake-orpc";

const h = vi.hoisted(() => {
	const handlers: Record<string, FakeHandler> = {};
	const calls: FakeCall[] = [];
	return { handlers, calls };
});
vi.mock("@/lib/rpc/client", async () => {
	const { fakeOrpc } = await import("@/tests/helpers/fake-orpc");
	return { orpc: fakeOrpc(h.handlers, h.calls).orpc };
});

import {
	adaptInventory,
	useCloudProviderResources,
	useCloudProviderStore,
} from "@/lib/stores/use-cloud-provider-store";

/** A minimal normalized inventory (one VPC + one VSwitch in cn-hangzhou). */
const INVENTORY = {
	networks: [
		{
			id: "row-net-1",
			native_id: "vpc-abc",
			region: "cn-hangzhou",
			name: "main",
			cidr_block: "10.0.0.0/16",
			is_default: false,
		},
	],
	subnets: [
		{
			id: "row-sub-1",
			native_id: "vsw-1",
			network_id: "row-net-1",
			region: "cn-hangzhou",
			name: "vsw-a",
			cidr_block: "10.0.1.0/24",
			availability_zone: "cn-hangzhou-a",
		},
	],
	regions: ["cn-hangzhou", "eu-central-1"],
};

const AWS_SHAPED = {
	regions: ["cn-hangzhou", "eu-central-1"],
	vpcs: {
		"cn-hangzhou": [{ ID: "vpc-abc", CIDR: "10.0.0.0/16", Name: "main", IsDefault: false }],
	},
	subnets: {
		"cn-hangzhou": {
			"vpc-abc": [
				{ ID: "vsw-1", CIDR: "10.0.1.0/24", VpcID: "vpc-abc", AvailabilityZone: "cn-hangzhou-a" },
			],
		},
	},
	hosted_zones: [],
};

let qc: QueryClient;

/** A QueryClientProvider over the test's client. */
function wrapper({ children }: { children: ReactNode }) {
	return createElement(QueryClientProvider, { client: qc }, children);
}

/** The inventory reads served, by identity. */
function inventoryReads(): unknown[] {
	return h.calls.filter((c) => c.path === "canvas.cloudInventory").map((c) => c.input);
}

beforeEach(() => {
	qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	h.calls.length = 0;
	h.handlers["canvas.cloudInventory"] = async () => INVENTORY;
	useCloudProviderStore.setState({ provider: "aws", identityId: null });
});

describe("adaptInventory", () => {
	it("adapts an alibaba identity's inventory to the AWS shape", () => {
		// @ts-expect-error the fixture carries only the columns the adapter reads
		expect(adaptInventory("alibaba", INVENTORY)).toEqual(AWS_SHAPED);
	});

	it("answers null for a token cloud, which has no VPCs", () => {
		// @ts-expect-error the fixture carries only the columns the adapter reads
		expect(adaptInventory("hetzner", INVENTORY)).toBeNull();
	});
});

describe("useCloudProviderResources — the selected identity's live inventory", () => {
	it("reads the inventory for the selected alibaba identity and adapts it", async () => {
		const { result } = renderHook(() => useCloudProviderResources(), { wrapper });
		act(() => useCloudProviderStore.getState().setIdentity("ci-ali", "alibaba"));
		await waitFor(() => expect(result.current.cachedResources).toEqual(AWS_SHAPED));
		expect(inventoryReads()).toEqual([{ identityId: "ci-ali" }]);
		expect(result.current.provider).toBe("alibaba");
		expect(result.current.isLoading).toBe(false);
		expect(result.current.error).toBeNull();
	});

	it("reads nothing before an identity is selected", async () => {
		const { result } = renderHook(() => useCloudProviderResources(), { wrapper });
		await new Promise((r) => setTimeout(r, 30));
		expect(inventoryReads()).toEqual([]);
		expect(result.current.cachedResources).toBeNull();
		expect(result.current.isLoading).toBe(false);
	});

	it("keeps hetzner resource-less (token cloud — no inventory read)", async () => {
		const { result } = renderHook(() => useCloudProviderResources(), { wrapper });
		act(() => useCloudProviderStore.getState().setIdentity("ci-hetzner", "hetzner"));
		await new Promise((r) => setTimeout(r, 30));
		expect(inventoryReads()).toEqual([]);
		expect(result.current.cachedResources).toBeNull();
		expect(result.current.isLoading).toBe(false);
		expect(result.current.error).toBeNull();
	});

	it("surfaces an inventory failure as an error with null resources, not as an empty account", async () => {
		h.handlers["canvas.cloudInventory"] = async () => {
			throw new Error("boom");
		};
		const { result } = renderHook(() => useCloudProviderResources(), { wrapper });
		act(() => useCloudProviderStore.getState().setIdentity("ci-ali", "alibaba"));
		await waitFor(() => expect(result.current.error).toBe("Failed to load cloud resources"));
		expect(result.current.cachedResources).toBeNull();
		expect(result.current.isLoading).toBe(false);
	});
});
