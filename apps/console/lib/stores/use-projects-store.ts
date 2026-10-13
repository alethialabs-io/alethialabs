// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

/**
 * Ephemeral projects UI state. The projects data itself lives in TanStack Query
 * (`useProjectsQuery`); this store only persists which projects the user has starred on
 * the overview (sorted first), across navigations (sessionStorage).
 */
interface ProjectsFavoritesStore {
	/** Project ids the user has starred on the overview (persisted; sorted first). */
	favoriteProjectIds: string[];
	/** Toggles a project's favorite (starred) state. */
	toggleFavorite: (projectId: string) => void;
}

/**
 * The favourites store. In render, read the ids through this hook (`useProjectsStore(...)`), never
 * `getState()`: the hook hands React `persist`'s pre-storage state as the server snapshot, so a
 * hydrating render shows nothing starred, as the server did, and the stored ids arrive a commit
 * later. Read live, a browser with a starred project hydrates a different list than the server
 * sent (React #418, #5840). `tests/components/projects-favourites-hydration.test.tsx` holds this.
 */
export const useProjectsStore = create<ProjectsFavoritesStore>()(
	persist(
		(set) => ({
			favoriteProjectIds: [],

			toggleFavorite: (projectId) => {
				set((state) => {
					const ids = new Set(state.favoriteProjectIds);
					if (ids.has(projectId)) ids.delete(projectId);
					else ids.add(projectId);
					return { favoriteProjectIds: [...ids] };
				});
			},
		}),
		{
			name: "projects-store",
			storage: createJSONStorage(() => sessionStorage),
			version: 1,
			partialize: (state) => ({ favoriteProjectIds: state.favoriteProjectIds }),
		},
	),
);
