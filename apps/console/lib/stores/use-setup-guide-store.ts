// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

"use client";

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { create } from "zustand";
import type { GettingStartedState } from "@/app/server/actions/onboarding";
import { orpc } from "@/lib/rpc/client";

interface SetupGuideStore {
	/** Whether the bottom-right card is open (ephemeral — never persisted). */
	open: boolean;
	/** Opens/closes the card. */
	setOpen: (open: boolean) => void;
	/** Toggles the card open/closed (the topbar button's action). */
	toggle: () => void;
}

/**
 * The setup guide's UI state: whether the bottom-right card is open. The topbar button and the
 * card both read it. The PROGRESS is server state and lives in `useSetupGuideQuery()` (ADR 0005 D5,
 * #6114) — completion is derived from real org state, and there is no persisted dismiss.
 */
export const useSetupGuideStore = create<SetupGuideStore>((set) => ({
	open: false,
	setOpen: (open) => set({ open }),
	toggle: () => set((s) => ({ open: !s.open })),
}));

/**
 * The org's onboarding progress over the read router's `workspace.setupGuide` (GET). The `[org]`
 * layout prefetches it, so the topbar ring renders on first paint instead of appearing after a
 * client fetch; the browser keeps one cache per org, so an org switch reads that org's progress.
 */
export function useSetupGuideQuery(): UseQueryResult<GettingStartedState> {
	return useQuery(orpc.workspace.setupGuide.queryOptions());
}
