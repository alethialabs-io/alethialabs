// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import {
	getProjects,
	type ProjectWithProvider,
} from "@/app/server/actions/projects";

/** How long cached projects are considered fresh (ms). */
const STALE_THRESHOLD = 30_000;

interface ProjectsStore {
	/** Cached projects (projects), flat under the org (in memory, not persisted). */
	projects: ProjectWithProvider[];
	isLoading: boolean;
	error: string | null;
	lastFetchedAt: number | null;

	/** Project ids the user has starred on the overview (persisted; sorted first). */
	favoriteProjectIds: string[];

	/** Fetches projects from the server, skipping if data is fresh. */
	fetchProjects: (force?: boolean) => Promise<void>;
	/** Toggles a project's favorite (starred) state. */
	toggleFavorite: (projectId: string) => void;
	/** Removes a project from the cached data (after deletion). */
	removeProject: (projectId: string) => void;
	/** Patches a single project's fields in place (e.g. from a realtime event). */
	updateProjectInPlace: (
		projectId: string,
		patch: Partial<ProjectWithProvider>,
	) => void;
}

export const useProjectsStore = create<ProjectsStore>()(
	persist(
		(set, get) => ({
			projects: [],
			isLoading: false,
			error: null,
			lastFetchedAt: null,
			favoriteProjectIds: [],

			fetchProjects: async (force = false) => {
				const { lastFetchedAt, isLoading } = get();
				if (isLoading) return;
				if (
					!force &&
					lastFetchedAt &&
					Date.now() - lastFetchedAt < STALE_THRESHOLD
				) {
					return;
				}
				set({ isLoading: true, error: null });
				try {
					const projects = await getProjects();
					set({
						projects,
						lastFetchedAt: Date.now(),
						isLoading: false,
						error: null,
					});
				} catch (err) {
					set({
						isLoading: false,
						error:
							err instanceof Error ? err.message : "Failed to fetch projects",
					});
				}
			},

			toggleFavorite: (projectId) => {
				set((state) => {
					const ids = new Set(state.favoriteProjectIds);
					if (ids.has(projectId)) ids.delete(projectId);
					else ids.add(projectId);
					return { favoriteProjectIds: [...ids] };
				});
			},

			removeProject: (projectId) => {
				set((state) => ({
					projects: state.projects.filter((p) => p.id !== projectId),
				}));
			},

			updateProjectInPlace: (projectId, patch) => {
				set((state) => ({
					projects: state.projects.map((p) =>
						p.id === projectId ? { ...p, ...patch } : p,
					),
				}));
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
