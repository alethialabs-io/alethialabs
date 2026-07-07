// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { getJobs } from "@/app/server/actions/jobs";

/** A job row as returned by the Drizzle-backed getJobs action. */
type JobRow = Awaited<ReturnType<typeof getJobs>>[number];
type PublicProvisionJobStatus = JobRow["status"];
type PublicProvisionJobType = JobRow["job_type"];

/**
 * Ephemeral jobs-list UI state. The jobs data itself lives in TanStack Query
 * (`useJobsQuery`); this store only persists the user's filter/pagination choices
 * across navigations (sessionStorage).
 */
interface JobsFilterStore {
	statusFilter: PublicProvisionJobStatus | "All";
	typeFilter: PublicProvisionJobType | "All";
	searchQuery: string;
	currentPage: number;
	pageSize: number;

	setStatusFilter: (s: PublicProvisionJobStatus | "All") => void;
	setTypeFilter: (t: PublicProvisionJobType | "All") => void;
	setSearchQuery: (q: string) => void;
	setCurrentPage: (p: number) => void;
	setPageSize: (s: number) => void;
}

export const useJobsStore = create<JobsFilterStore>()(
	persist(
		(set) => ({
			statusFilter: "All",
			typeFilter: "All",
			searchQuery: "",
			currentPage: 0,
			pageSize: 20,

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
		},
	),
);

export type { PublicProvisionJobStatus, PublicProvisionJobType };
