// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

/**
 * Which projects each person has starred on the overview (starred projects sort first). The
 * projects themselves live in TanStack Query; this store holds only the stars.
 *
 * Kept in `localStorage`, keyed by the signed-in person: a star is still there in a new tab and
 * after the browser restarts, and a second account on the same browser has its own. It is not
 * shared between browsers or devices: there is no server record of it.
 */
interface ProjectsFavoritesStore {
	/** Starred project ids, by the id of the person who starred them. */
	favoritesByUser: Record<string, string[]>;
	/** Stars the project for that person, or removes the star if it has one. */
	toggleFavorite: (userId: string, projectId: string) => void;
}

/** The answer for somebody with no stars. One array, so a selector returning it never changes identity. */
const NO_FAVORITES: string[] = [];

/** The key the stars are stored under in `localStorage`. */
export const PROJECTS_FAVORITES_STORAGE_KEY = "projects-favourites";

/**
 * The favourites store. In render, read the ids through {@link useFavoriteProjectIds}, never
 * `getState()`: the hook hands React `persist`'s pre-storage state as the server snapshot, so a
 * hydrating render shows nothing starred, as the server did, and the stored ids arrive a commit
 * later. Read live, a browser with a starred project hydrates a different list than the server
 * sent (React #418, #5840). `tests/components/projects-favourites-hydration.test.tsx` holds this.
 */
export const useProjectsStore = create<ProjectsFavoritesStore>()(
	persist(
		(set) => ({
			favoritesByUser: {},

			toggleFavorite: (userId, projectId) => {
				set((state) => {
					const ids = new Set(state.favoritesByUser[userId] ?? NO_FAVORITES);
					if (ids.has(projectId)) ids.delete(projectId);
					else ids.add(projectId);
					return { favoritesByUser: { ...state.favoritesByUser, [userId]: [...ids] } };
				});
			},
		}),
		{
			name: PROJECTS_FAVORITES_STORAGE_KEY,
			storage: createJSONStorage(() => localStorage),
			version: 1,
			partialize: (state) => ({ favoritesByUser: state.favoritesByUser }),
		},
	),
);

/**
 * The project ids `userId` has starred, in the order they were starred. Empty while nobody is
 * signed in (`null`) and during the server and hydrating renders.
 */
export function useFavoriteProjectIds(userId: string | null): string[] {
	return useProjectsStore((state) =>
		userId === null ? NO_FAVORITES : (state.favoritesByUser[userId] ?? NO_FAVORITES),
	);
}
