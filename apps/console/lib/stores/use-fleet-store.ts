// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Client store for the Fleet cockpit: holds the pool views (observed) and drives CRUD
// through the fleet server actions. The page polls `fetch()` on the runner cadence;
// mutations re-fetch so the cards reflect the controller's next reconcile.

import {
	createFleetPool,
	deleteFleetPool,
	getFleetEconomics,
	getFleetPoolViews,
	listFleetPoolConfigs,
	setFleetPoolEnabled,
	updateFleetPool,
	type FleetEconomics,
	type FleetPoolView,
} from "@/app/server/actions/fleet";
import type { FleetPool } from "@/lib/db/schema";
import type { FleetPoolCreateInput, FleetPoolUpdateInput } from "@/lib/validations/fleet";
import { create } from "zustand";

interface FleetStore {
	pools: FleetPoolView[];
	/** Raw stored rows — the edit form needs the knobs the view doesn't render. */
	configs: FleetPool[];
	/** Month-to-date COGS/utilization — manager-only (null for viewers/operators). */
	economics: FleetEconomics | null;
	fleetProviderActive: boolean;
	canManageFleet: boolean;
	isLoading: boolean;
	loaded: boolean;
	fetch: () => Promise<void>;
	createPool: (input: FleetPoolCreateInput) => Promise<void>;
	updatePool: (id: string, input: FleetPoolUpdateInput) => Promise<void>;
	setEnabled: (id: string, enabled: boolean) => Promise<void>;
	deletePool: (id: string) => Promise<void>;
}

export const useFleetStore = create<FleetStore>((set, get) => ({
	pools: [],
	configs: [],
	economics: null,
	fleetProviderActive: false,
	canManageFleet: false,
	isLoading: false,
	loaded: false,

	fetch: async () => {
		if (get().isLoading) return;
		set({ isLoading: true });
		try {
			const { pools, fleetProviderActive, canManageFleet } = await getFleetPoolViews();
			// Raw configs + economics are manager-only (owner/admin) — both require fleet
			// capabilities operators/viewers lack, so only fetch them when allowed.
			const [configs, economics] = canManageFleet
				? await Promise.all([listFleetPoolConfigs(), getFleetEconomics()])
				: [[], null];
			set({ pools, configs, economics, fleetProviderActive, canManageFleet, loaded: true });
		} finally {
			set({ isLoading: false });
		}
	},

	createPool: async (input) => {
		await createFleetPool(input);
		await get().fetch();
	},

	updatePool: async (id, input) => {
		await updateFleetPool(id, input);
		await get().fetch();
	},

	setEnabled: async (id, enabled) => {
		// Optimistic flip so pause/resume feels instant; the re-fetch reconciles.
		set((s) => ({ pools: s.pools.map((p) => (p.id === id ? { ...p, enabled } : p)) }));
		await setFleetPoolEnabled(id, enabled);
		await get().fetch();
	},

	deletePool: async (id) => {
		set((s) => ({ pools: s.pools.filter((p) => p.id !== id) }));
		await deleteFleetPool(id);
		await get().fetch();
	},
}));
