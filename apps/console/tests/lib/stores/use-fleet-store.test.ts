// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Fleet cockpit client store (lib/stores/use-fleet-store.ts). Mocked boundary: the fleet
// server actions. Assert that fetch() wires the views into state, gates manager-only
// configs/economics behind canManageFleet, is re-entrancy guarded, and that the CRUD
// actions call the right action and re-fetch — plus the optimistic flips for
// setEnabled/deletePool.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/server/actions/fleet", () => ({
	getFleetPoolViews: vi.fn(),
	listFleetPoolConfigs: vi.fn(),
	getFleetEconomics: vi.fn(),
	createFleetPool: vi.fn(),
	updateFleetPool: vi.fn(),
	setFleetPoolEnabled: vi.fn(),
	deleteFleetPool: vi.fn(),
}));

import { useFleetStore } from "@/lib/stores/use-fleet-store";
import {
	createFleetPool,
	deleteFleetPool,
	getFleetEconomics,
	getFleetPoolViews,
	listFleetPoolConfigs,
	setFleetPoolEnabled,
	updateFleetPool,
} from "@/app/server/actions/fleet";

/** A minimal pool view fixture; only id/enabled are read by the store. */
const view = (id: string, enabled = true) => ({ id, enabled }) as never;

const INITIAL = {
	pools: [],
	configs: [],
	economics: null,
	fleetProviderActive: false,
	canManageFleet: false,
	isLoading: false,
	loaded: false,
};

beforeEach(() => {
	vi.clearAllMocks();
	useFleetStore.setState({ ...INITIAL });
});
afterEach(() => {
	useFleetStore.setState({ ...INITIAL });
});

describe("fetch", () => {
	it("loads manager-only configs + economics when canManageFleet is true", async () => {
		vi.mocked(getFleetPoolViews).mockResolvedValue({
			pools: [view("p1"), view("p2")],
			fleetProviderActive: true,
			canManageFleet: true,
		} as never);
		vi.mocked(listFleetPoolConfigs).mockResolvedValue([{ id: "p1" }] as never);
		vi.mocked(getFleetEconomics).mockResolvedValue({ cogsCents: 4200 } as never);

		await useFleetStore.getState().fetch();

		const s = useFleetStore.getState();
		expect(s.pools.map((p) => p.id)).toEqual(["p1", "p2"]);
		expect(s.configs).toEqual([{ id: "p1" }]);
		expect(s.economics).toEqual({ cogsCents: 4200 });
		expect(s.fleetProviderActive).toBe(true);
		expect(s.canManageFleet).toBe(true);
		expect(s.loaded).toBe(true);
		expect(s.isLoading).toBe(false);
		expect(listFleetPoolConfigs).toHaveBeenCalledTimes(1);
		expect(getFleetEconomics).toHaveBeenCalledTimes(1);
	});

	it("skips the manager-only fetches when canManageFleet is false", async () => {
		vi.mocked(getFleetPoolViews).mockResolvedValue({
			pools: [view("p1")],
			fleetProviderActive: false,
			canManageFleet: false,
		} as never);

		await useFleetStore.getState().fetch();

		const s = useFleetStore.getState();
		expect(s.configs).toEqual([]);
		expect(s.economics).toBeNull();
		expect(s.loaded).toBe(true);
		expect(listFleetPoolConfigs).not.toHaveBeenCalled();
		expect(getFleetEconomics).not.toHaveBeenCalled();
	});

	it("is a no-op while a fetch is already in flight", async () => {
		useFleetStore.setState({ isLoading: true });
		await useFleetStore.getState().fetch();
		expect(getFleetPoolViews).not.toHaveBeenCalled();
	});

	it("clears isLoading even if the views call rejects", async () => {
		vi.mocked(getFleetPoolViews).mockRejectedValue(new Error("boom"));
		await expect(useFleetStore.getState().fetch()).rejects.toThrow("boom");
		expect(useFleetStore.getState().isLoading).toBe(false);
	});
});

describe("createPool / updatePool", () => {
	beforeEach(() => {
		vi.mocked(getFleetPoolViews).mockResolvedValue({
			pools: [],
			fleetProviderActive: false,
			canManageFleet: false,
		} as never);
	});

	it("createPool forwards the input then re-fetches", async () => {
		const input = { provider: "hcloud" } as never;
		await useFleetStore.getState().createPool(input);
		expect(createFleetPool).toHaveBeenCalledWith(input);
		expect(getFleetPoolViews).toHaveBeenCalledTimes(1);
	});

	it("updatePool forwards id + input then re-fetches", async () => {
		const input = { minWarm: 3 } as never;
		await useFleetStore.getState().updatePool("p9", input);
		expect(updateFleetPool).toHaveBeenCalledWith("p9", input);
		expect(getFleetPoolViews).toHaveBeenCalledTimes(1);
	});
});

describe("setEnabled — optimistic flip", () => {
	it("flips the matching pool's enabled before the action resolves, then re-fetches", async () => {
		useFleetStore.setState({ pools: [view("a", true), view("b", true)] });
		// Re-fetch returns the reconciled state.
		vi.mocked(getFleetPoolViews).mockResolvedValue({
			pools: [view("a", false), view("b", true)],
			fleetProviderActive: false,
			canManageFleet: false,
		} as never);

		// Capture the optimistic state synchronously, before setFleetPoolEnabled resolves.
		let optimistic: boolean | undefined;
		vi.mocked(setFleetPoolEnabled).mockImplementation((async () => {
			optimistic = useFleetStore.getState().pools.find((p) => p.id === "a")?.enabled;
		}) as never);

		await useFleetStore.getState().setEnabled("a", false);

		expect(optimistic).toBe(false);
		expect(setFleetPoolEnabled).toHaveBeenCalledWith("a", false);
		expect(useFleetStore.getState().pools.find((p) => p.id === "b")?.enabled).toBe(true);
	});
});

describe("deletePool — optimistic removal", () => {
	it("removes the pool optimistically then calls the action + re-fetches", async () => {
		useFleetStore.setState({ pools: [view("x"), view("y")] });
		vi.mocked(getFleetPoolViews).mockResolvedValue({
			pools: [view("y")],
			fleetProviderActive: false,
			canManageFleet: false,
		} as never);

		let optimisticIds: string[] | undefined;
		vi.mocked(deleteFleetPool).mockImplementation((async () => {
			optimisticIds = useFleetStore.getState().pools.map((p) => p.id);
		}) as never);

		await useFleetStore.getState().deletePool("x");

		expect(optimisticIds).toEqual(["y"]);
		expect(deleteFleetPool).toHaveBeenCalledWith("x");
		expect(useFleetStore.getState().pools.map((p) => p.id)).toEqual(["y"]);
	});
});
