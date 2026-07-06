// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Jobs filter store (lib/stores/use-jobs-store.ts). The jobs data itself now lives in
// TanStack Query (useJobsQuery); this store only holds the ephemeral filter/pagination
// UI state, so the tests cover the page-resetting filter setters.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useJobsStore } from "@/lib/stores/use-jobs-store";

// A fresh, deterministic starting point for every test (the store is a singleton module).
const INITIAL = {
	statusFilter: "All",
	typeFilter: "All",
	searchQuery: "",
	currentPage: 0,
	pageSize: 20,
} as const;

beforeEach(() => {
	useJobsStore.setState({ ...INITIAL } as never, false);
});

afterEach(() => {
	useJobsStore.setState({ ...INITIAL } as never, false);
});

describe("filter / pagination setters", () => {
	it("setStatusFilter sets the filter and resets currentPage", () => {
		useJobsStore.setState({ currentPage: 4 } as never, false);

		useJobsStore.getState().setStatusFilter("QUEUED" as never);
		const s = useJobsStore.getState();

		expect(s.statusFilter).toBe("QUEUED");
		expect(s.currentPage).toBe(0);
	});

	it("setTypeFilter sets the filter and resets currentPage", () => {
		useJobsStore.setState({ currentPage: 4 } as never, false);

		useJobsStore.getState().setTypeFilter("DESTROY" as never);
		const s = useJobsStore.getState();

		expect(s.typeFilter).toBe("DESTROY");
		expect(s.currentPage).toBe(0);
	});

	it("setSearchQuery sets the query and resets currentPage", () => {
		useJobsStore.setState({ currentPage: 4 } as never, false);

		useJobsStore.getState().setSearchQuery("prod");
		const s = useJobsStore.getState();

		expect(s.searchQuery).toBe("prod");
		expect(s.currentPage).toBe(0);
	});

	it("setPageSize sets the size and resets currentPage", () => {
		useJobsStore.setState({ currentPage: 4 } as never, false);

		useJobsStore.getState().setPageSize(50);
		const s = useJobsStore.getState();

		expect(s.pageSize).toBe(50);
		expect(s.currentPage).toBe(0);
	});

	it("setCurrentPage changes only the page (no reset)", () => {
		useJobsStore.getState().setCurrentPage(3);

		expect(useJobsStore.getState().currentPage).toBe(3);
	});
});
