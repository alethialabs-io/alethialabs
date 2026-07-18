// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// State for the single-page Alerts hub (Policies · Channels · Activity). A module-level
// store so the page, the secondary sidebar drill, and the two panels all stay in sync
// without threading context through the app shell:
//   - `active` drives the sidebar scroll-spy highlight.
//   - `selectedPolicyId` / `selectedChannelId` are the master-detail selections, lifted
//     here so cross-links work (a channel's "used by" can open a policy, and vice-versa).

import { create } from "zustand";

/** The three stacked sections, matching their anchor `id`s on the page. */
export const ALERTS_SECTIONS = ["policies", "channels", "activity"] as const;
export type AlertsSection = (typeof ALERTS_SECTIONS)[number];

interface AlertsSectionStore {
	active: AlertsSection;
	setActive: (section: AlertsSection) => void;
	/** Selected policy in the Policies master-detail (null = fall back to the first). */
	selectedPolicyId: string | null;
	setSelectedPolicyId: (id: string | null) => void;
	/** Selected channel in the Channels master-detail (null = fall back to the first). */
	selectedChannelId: string | null;
	setSelectedChannelId: (id: string | null) => void;
}

export const useAlertsSection = create<AlertsSectionStore>((set) => ({
	active: "policies",
	setActive: (active) => set({ active }),
	selectedPolicyId: null,
	setSelectedPolicyId: (selectedPolicyId) => set({ selectedPolicyId }),
	selectedChannelId: null,
	setSelectedChannelId: (selectedChannelId) => set({ selectedChannelId }),
}));
