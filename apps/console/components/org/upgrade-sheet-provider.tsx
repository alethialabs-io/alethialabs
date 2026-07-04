"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// One shared UpgradeOrgSheet mounted per org shell, opened from anywhere via
// `useUpgradeSheet().openUpgrade()`. Every "Upgrade to Pro" CTA (sidebar, usage/overview
// cards, feature upsells, the billing panel) opens THIS sheet in place instead of routing
// to /settings/billing — the upgrade is a purchase, not a page. The sheet only mints a
// subscription intent when it actually opens (its own effect is gated on `open`), so
// mounting it idle here is free.

import { createContext, useContext, useMemo, useState } from "react";
import { UpgradeOrgSheet } from "@/components/org/upgrade-org-sheet";
import { useActiveOrgSlug } from "@/lib/stores/use-workspace-store";

interface UpgradeSheetContextValue {
	/** Open the Pro upgrade sheet for the active organization. */
	openUpgrade: () => void;
}

const UpgradeSheetContext = createContext<UpgradeSheetContextValue | null>(null);

export function UpgradeSheetProvider({ children }: { children: React.ReactNode }) {
	const [open, setOpen] = useState(false);
	const orgSlug = useActiveOrgSlug();
	const value = useMemo<UpgradeSheetContextValue>(
		() => ({ openUpgrade: () => setOpen(true) }),
		[],
	);
	return (
		<UpgradeSheetContext.Provider value={value}>
			{children}
			<UpgradeOrgSheet open={open} onOpenChange={setOpen} orgSlug={orgSlug} />
		</UpgradeSheetContext.Provider>
	);
}

/** Open the shared Pro upgrade sheet. Must be used within an <UpgradeSheetProvider>. */
export function useUpgradeSheet(): UpgradeSheetContextValue {
	const ctx = useContext(UpgradeSheetContext);
	if (!ctx) {
		throw new Error("useUpgradeSheet must be used within an UpgradeSheetProvider");
	}
	return ctx;
}
