// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Jobs zustand store (lib/stores/use-jobs-store.ts). Boundary mocked: the getJobs server action.
// Drives the real store via getState()/actions and asserts the state transitions: the
// stale-window / force / in-flight guards of fetchJobs, its success + error branches, the
// insert/update + created_at-desc sort of addOrUpdateJob, and the page-resetting filter setters.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/server/actions/jobs", () => ({ getJobs: vi.fn() }));

import { useJobsStore } from "@/lib/stores/use-jobs-store";
import { getJobs } from "@/app/server/actions/jobs";

const mockGetJobs = vi.mocked(getJobs);

/** Build a job row fixture; only the fields the store touches are meaningful. */
const job = (id: string, createdAt: string | null, over: Record<string, unknown> = {}) =>
	({ id, created_at: createdAt, status: "queued", job_type: "apply", ...over } as never);

// A fresh, deterministic starting point for every test (the store is a singleton module).
const INITIAL = {
	jobs: [],
	isLoading: false,
	error: null,
	lastFetchedAt: null,
	statusFilter: "All",
	typeFilter: "All",
	searchQuery: "",
	currentPage: 0,
	pageSize: 20,
} as const;

beforeEach(() => {
	vi.clearAllMocks();
	useJobsStore.setState({ ...INITIAL } as never, false);
});

afterEach(() => {
	vi.useRealTimers();
});

describe("fetchJobs", () => {
	it("loads jobs and records lastFetchedAt on success", async () => {
		const rows = [job("a", "2026-01-01T00:00:00Z")];
		mockGetJobs.mockResolvedValueOnce(rows as never);

		const before = Date.now();
		await useJobsStore.getState().fetchJobs();
		const s = useJobsStore.getState();

		expect(mockGetJobs).toHaveBeenCalledTimes(1);
		expect(s.jobs).toBe(rows as never);
		expect(s.isLoading).toBe(false);
		expect(s.error).toBeNull();
		expect(s.lastFetchedAt).toBeGreaterThanOrEqual(before);
	});

	it("skips the fetch when cached data is still fresh", async () => {
		useJobsStore.setState({ lastFetchedAt: Date.now() } as never, false);

		await useJobsStore.getState().fetchJobs();

		expect(mockGetJobs).not.toHaveBeenCalled();
	});

	it("refetches fresh data when force=true", async () => {
		useJobsStore.setState({ lastFetchedAt: Date.now() } as never, false);
		mockGetJobs.mockResolvedValueOnce([] as never);

		await useJobsStore.getState().fetchJobs(true);

		expect(mockGetJobs).toHaveBeenCalledTimes(1);
	});

	it("refetches once the cache is older than the stale threshold", async () => {
		// 30s stale window — set lastFetchedAt 31s in the past.
		useJobsStore.setState({ lastFetchedAt: Date.now() - 31_000 } as never, false);
		mockGetJobs.mockResolvedValueOnce([] as never);

		await useJobsStore.getState().fetchJobs();

		expect(mockGetJobs).toHaveBeenCalledTimes(1);
	});

	it("is a no-op while a fetch is already in flight", async () => {
		useJobsStore.setState({ isLoading: true } as never, false);

		await useJobsStore.getState().fetchJobs(true);

		expect(mockGetJobs).not.toHaveBeenCalled();
	});

	it("captures the error message and clears loading on failure", async () => {
		mockGetJobs.mockRejectedValueOnce(new Error("boom"));
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		await useJobsStore.getState().fetchJobs();
		const s = useJobsStore.getState();

		expect(s.isLoading).toBe(false);
		expect(s.error).toBe("boom");
		expect(s.jobs).toEqual([]);
		errSpy.mockRestore();
	});

	it("falls back to a generic message for non-Error rejections", async () => {
		mockGetJobs.mockRejectedValueOnce("oops");
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		await useJobsStore.getState().fetchJobs();

		expect(useJobsStore.getState().error).toBe("Failed to fetch jobs");
		errSpy.mockRestore();
	});
});

describe("addOrUpdateJob", () => {
	it("prepends a new job and sorts by created_at descending", () => {
		useJobsStore.setState(
			{ jobs: [job("old", "2026-01-01T00:00:00Z")] } as never,
			false,
		);

		useJobsStore.getState().addOrUpdateJob(job("new", "2026-02-01T00:00:00Z"));
		const ids = useJobsStore.getState().jobs.map((j) => j.id);

		expect(ids).toEqual(["new", "old"]);
	});

	it("updates an existing job in place (matched by id) without duplicating it", () => {
		useJobsStore.setState(
			{
				jobs: [
					job("a", "2026-03-01T00:00:00Z"),
					job("b", "2026-01-01T00:00:00Z"),
				],
			} as never,
			false,
		);

		useJobsStore
			.getState()
			.addOrUpdateJob(job("b", "2026-01-01T00:00:00Z", { status: "succeeded" }));
		const s = useJobsStore.getState();

		expect(s.jobs).toHaveLength(2);
		const updated = s.jobs.find((j) => j.id === "b") as { status: string };
		expect(updated.status).toBe("succeeded");
	});

	it("treats a missing created_at as epoch (sorts it last)", () => {
		useJobsStore.setState({ jobs: [job("dated", "2026-05-01T00:00:00Z")] } as never, false);

		useJobsStore.getState().addOrUpdateJob(job("undated", null));
		const ids = useJobsStore.getState().jobs.map((j) => j.id);

		expect(ids).toEqual(["dated", "undated"]);
	});
});

describe("filter / pagination setters", () => {
	it("setStatusFilter sets the filter and resets currentPage", () => {
		useJobsStore.setState({ currentPage: 4 } as never, false);

		useJobsStore.getState().setStatusFilter("queued" as never);
		const s = useJobsStore.getState();

		expect(s.statusFilter).toBe("queued");
		expect(s.currentPage).toBe(0);
	});

	it("setTypeFilter sets the filter and resets currentPage", () => {
		useJobsStore.setState({ currentPage: 4 } as never, false);

		useJobsStore.getState().setTypeFilter("destroy" as never);
		const s = useJobsStore.getState();

		expect(s.typeFilter).toBe("destroy");
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
