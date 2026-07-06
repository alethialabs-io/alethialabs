// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Collapsible-sidebar state for the project workspace. At project scope the app-shell sidebar can
// collapse to an icon rail: it auto-collapses on the Architecture canvas (which wants the width) and
// auto-expands whenever a nested-nav drill (Settings) is open. A manual toggle pins the user's choice
// (persisted), overriding the route default. Org scope is always expanded — this state is ignored there.

import { usePathname } from "next/navigation";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { projectScope, routeOwnedDrill } from "@/components/shell/nav-config";

interface SidebarStore {
	/** User override: `null` follows the route default; `true`/`false` pins collapsed/expanded. */
	override: boolean | null;
	setOverride: (override: boolean | null) => void;
}

/** Persisted store for the manual collapse override (localStorage → survives reloads). */
export const useSidebarStore = create<SidebarStore>()(
	persist(
		(set) => ({
			override: null,
			setOverride: (override) => set({ override }),
		}),
		{
			name: "alethia-sidebar",
			storage: createJSONStorage(() => localStorage),
			version: 1,
		},
	),
);

/**
 * Derives the effective sidebar collapse state for the current route and lets callers toggle it.
 * `collapsed` is only ever true inside a project, never while a nested-nav drill is open (that must
 * stay visible); the Architecture canvas is the route default-collapsed. `toggle` pins the opposite
 * of the current effective state; `canToggle` hides the control where collapsing makes no sense.
 */
export function useSidebarCollapse(): {
	collapsed: boolean;
	toggle: () => void;
	canToggle: boolean;
} {
	const pathname = usePathname();
	const override = useSidebarStore((s) => s.override);
	const setOverride = useSidebarStore((s) => s.setOverride);

	const inProject = projectScope(pathname) != null;
	const drilled = routeOwnedDrill(pathname) != null;
	const routeWantsCollapsed = pathname.endsWith("/architecture");

	const collapsed = inProject && !drilled && (override ?? routeWantsCollapsed);
	const canToggle = inProject && !drilled;

	return {
		collapsed,
		toggle: () => setOverride(!collapsed),
		canToggle,
	};
}
