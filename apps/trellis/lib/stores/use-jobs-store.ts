import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { getJobs } from "@/app/server/actions/jobs";
import type {
	PublicProvisionJobsRow,
	PublicProvisionJobType,
	PublicProvisionJobStatus,
} from "@/lib/validations/db.schemas";

/** How long cached jobs are considered fresh (ms). */
const STALE_THRESHOLD = 30_000;

interface JobsStore {
	/** Cached jobs array (in memory, not persisted). */
	jobs: PublicProvisionJobsRow[];
	isLoading: boolean;
	error: string | null;
	lastFetchedAt: number | null;

	/** Filters (persisted to sessionStorage). */
	statusFilter: PublicProvisionJobStatus | "All";
	typeFilter: PublicProvisionJobType | "All";
	searchQuery: string;
	currentPage: number;
	pageSize: number;

	/** Fetches jobs from the server, skipping if data is fresh. */
	fetchJobs: (force?: boolean) => Promise<void>;
	/** Inserts or updates a job from a realtime event. */
	addOrUpdateJob: (job: PublicProvisionJobsRow) => void;
	setStatusFilter: (s: PublicProvisionJobStatus | "All") => void;
	setTypeFilter: (t: PublicProvisionJobType | "All") => void;
	setSearchQuery: (q: string) => void;
	setCurrentPage: (p: number) => void;
	setPageSize: (s: number) => void;
}

export const useJobsStore = create<JobsStore>()(
	persist(
		(set, get) => ({
			jobs: [],
			isLoading: false,
			error: null,
			lastFetchedAt: null,

			statusFilter: "All",
			typeFilter: "All",
			searchQuery: "",
			currentPage: 0,
			pageSize: 20,

			fetchJobs: async (force = false) => {
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
					const data = await getJobs();
					set({
						jobs: data as PublicProvisionJobsRow[],
						lastFetchedAt: Date.now(),
						isLoading: false,
						error: null,
					});
				} catch (err) {
					console.error("[jobs-store] fetchJobs failed:", err);
					set({ isLoading: false, error: err instanceof Error ? err.message : "Failed to fetch jobs" });
				}
			},

			addOrUpdateJob: (job) => {
				set((state) => {
					const idx = state.jobs.findIndex((j) => j.id === job.id);
					let updated: PublicProvisionJobsRow[];

					if (idx >= 0) {
						updated = [...state.jobs];
						updated[idx] = job;
					} else {
						updated = [job, ...state.jobs];
					}

					updated.sort((a, b) => {
						const aTime = a.created_at
							? new Date(a.created_at).getTime()
							: 0;
						const bTime = b.created_at
							? new Date(b.created_at).getTime()
							: 0;
						return bTime - aTime;
					});

					return { jobs: updated };
				});
			},

			setStatusFilter: (s) => set({ statusFilter: s, currentPage: 0 }),
			setTypeFilter: (t) => set({ typeFilter: t, currentPage: 0 }),
			setSearchQuery: (q) => set({ searchQuery: q, currentPage: 0 }),
			setCurrentPage: (p) => set({ currentPage: p }),
			setPageSize: (s) => set({ pageSize: s, currentPage: 0 }),
		}),
		{
			name: "jobs-store",
			storage: createJSONStorage(() => sessionStorage),
			version: 1,
			partialize: (state) => ({
				statusFilter: state.statusFilter,
				typeFilter: state.typeFilter,
				searchQuery: state.searchQuery,
				currentPage: state.currentPage,
				pageSize: state.pageSize,
			}),
			onRehydrateStorage: () => (state) => {
				if (state && state.jobs.length === 0) {
					state.statusFilter = "All";
					state.typeFilter = "All";
					state.searchQuery = "";
					state.currentPage = 0;
				}
			},
		},
	),
);

export type { PublicProvisionJobStatus, PublicProvisionJobType };
