// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { create } from "zustand";
import {
	getGettingStartedState,
	type GettingStartedState,
} from "@/app/server/actions/onboarding";

interface SetupGuideStore {
	/** Real-data onboarding progress (null until first fetch). */
	state: GettingStartedState | null;
	loading: boolean;
	/** Whether the bottom-right card is open (ephemeral — never persisted). */
	open: boolean;

	/** Fetches onboarding progress from the server; refetch-on-demand (e.g. org switch). */
	fetch: () => Promise<void>;
	/** Opens/closes the card. */
	setOpen: (open: boolean) => void;
	/** Toggles the card open/closed (the topbar button's action). */
	toggle: () => void;
}

/**
 * Shared state for the "Setup guide": the topbar button (collapsed state) and the
 * bottom-right card (open state) both read from here, so the progress ring and the
 * checklist never disagree. Completion is derived from real org state — there is no
 * persisted dismiss; closing the card just sets `open` false, reopenable any time.
 */
export const useSetupGuideStore = create<SetupGuideStore>((set, get) => ({
	state: null,
	loading: false,
	open: false,

	fetch: async () => {
		if (get().loading) return;
		set({ loading: true });
		try {
			const state = await getGettingStartedState();
			set({ state, loading: false });
		} catch {
			// Non-fatal — just leave the guide hidden.
			set({ loading: false });
		}
	},

	setOpen: (open) => set({ open }),
	toggle: () => set((s) => ({ open: !s.open })),
}));
