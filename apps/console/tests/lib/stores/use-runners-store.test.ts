// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Unit test for the runners zustand store (lib/stores/use-runners-store.ts). The only boundary is
// the server-action module @/app/server/actions/runners — everything else (merge/map logic, the
// stale/loading guards, allSettled tallying) is the real store. We drive actions via getState() and
// assert resulting state + which mock was called with what.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
	setDefaultRunnerAction,
	deployRunnerAction,
	destroyRunnerAction,
	removeRunnerAction,
	updateRunnerAction,
	getRunnersWithReleases,
	getManagedRunnersWithReleases,
	getLatestRunnerRelease,
	getManagedRunnerUsage,
	getReleaseNotes,
} = vi.hoisted(() => ({
	setDefaultRunnerAction: vi.fn(),
	deployRunnerAction: vi.fn(),
	destroyRunnerAction: vi.fn(),
	removeRunnerAction: vi.fn(),
	updateRunnerAction: vi.fn(),
	getRunnersWithReleases: vi.fn(),
	getManagedRunnersWithReleases: vi.fn(),
	getLatestRunnerRelease: vi.fn(),
	getManagedRunnerUsage: vi.fn(),
	getReleaseNotes: vi.fn(),
}));

vi.mock("@/app/server/actions/runners", () => ({
	setDefaultRunner: setDefaultRunnerAction,
	deployRunner: deployRunnerAction,
	destroyRunner: destroyRunnerAction,
	removeRunner: removeRunnerAction,
	updateRunner: updateRunnerAction,
	getRunnersWithReleases,
	getManagedRunnersWithReleases,
	getLatestRunnerRelease,
	getManagedRunnerUsage,
	getReleaseNotes,
}));

import {
	useRunnersStore,
	type RunnerWithRelease,
} from "@/lib/stores/use-runners-store";

/** Build a minimal runner fixture; only fields the store touches matter. */
function makeRunner(
	overrides: Partial<RunnerWithRelease> & { id: string },
): RunnerWithRelease {
	return {
		operator: "self",
		is_default: false,
		runner_releases: null,
		provisioned_hours: null,
		...overrides,
	} as never;
}

const INITIAL = {
	runners: [],
	latestRelease: null,
	isLoading: false,
	error: null,
	lastFetchedAt: null,
};

beforeEach(() => {
	vi.clearAllMocks();
	useRunnersStore.setState({ ...INITIAL }, false);
	// Sensible defaults so fetchRunners resolves unless a test overrides them.
	getRunnersWithReleases.mockResolvedValue([]);
	getManagedRunnersWithReleases.mockResolvedValue([]);
	getLatestRunnerRelease.mockResolvedValue(null);
	getManagedRunnerUsage.mockResolvedValue({});
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("fetchRunners", () => {
	it("merges own + managed runners and maps provisioned_hours per operator", async () => {
		getRunnersWithReleases.mockResolvedValue([
			makeRunner({ id: "self-1", operator: "self" }),
		]);
		getManagedRunnersWithReleases.mockResolvedValue([
			makeRunner({ id: "mgd-1", operator: "managed" }),
			makeRunner({ id: "mgd-2", operator: "managed" }),
		]);
		getManagedRunnerUsage.mockResolvedValue({ "mgd-1": 12.5 });
		const release = { version: "1.2.3" };
		getLatestRunnerRelease.mockResolvedValue(release as never);

		await useRunnersStore.getState().fetchRunners();
		const s = useRunnersStore.getState();

		expect(s.runners.map((r) => r.id)).toEqual(["self-1", "mgd-1", "mgd-2"]);
		// self → null, managed with usage → that value, managed without usage → 0
		expect(s.runners.find((r) => r.id === "self-1")?.provisioned_hours).toBeNull();
		expect(s.runners.find((r) => r.id === "mgd-1")?.provisioned_hours).toBe(12.5);
		expect(s.runners.find((r) => r.id === "mgd-2")?.provisioned_hours).toBe(0);
		expect(s.latestRelease).toBe(release);
		expect(s.isLoading).toBe(false);
		expect(s.error).toBeNull();
		expect(s.lastFetchedAt).toBeTypeOf("number");
	});

	it("no-ops while a fetch is already in flight", async () => {
		useRunnersStore.setState({ isLoading: true });
		await useRunnersStore.getState().fetchRunners();
		expect(getRunnersWithReleases).not.toHaveBeenCalled();
	});

	it("skips a non-forced fetch within the stale threshold", async () => {
		useRunnersStore.setState({ lastFetchedAt: Date.now() });
		await useRunnersStore.getState().fetchRunners();
		expect(getRunnersWithReleases).not.toHaveBeenCalled();
	});

	it("force=true bypasses the stale-threshold guard", async () => {
		useRunnersStore.setState({ lastFetchedAt: Date.now() });
		await useRunnersStore.getState().fetchRunners(true);
		expect(getRunnersWithReleases).toHaveBeenCalledTimes(1);
	});

	it("captures the error message and clears the loading flag on failure", async () => {
		getRunnersWithReleases.mockRejectedValue(new Error("boom"));
		await useRunnersStore.getState().fetchRunners();
		const s = useRunnersStore.getState();
		expect(s.error).toBe("boom");
		expect(s.isLoading).toBe(false);
	});

	it("falls back to a generic error message for non-Error throws", async () => {
		getRunnersWithReleases.mockRejectedValue("nope");
		await useRunnersStore.getState().fetchRunners();
		expect(useRunnersStore.getState().error).toBe("Failed to fetch runners");
	});
});

describe("addOrUpdateRunner / removeRunner", () => {
	it("appends a new runner", () => {
		useRunnersStore.getState().addOrUpdateRunner(makeRunner({ id: "a" }));
		expect(useRunnersStore.getState().runners.map((r) => r.id)).toEqual(["a"]);
	});

	it("replaces an existing runner in place by id", () => {
		useRunnersStore.setState({
			runners: [makeRunner({ id: "a", is_default: false }), makeRunner({ id: "b" })],
		});
		useRunnersStore
			.getState()
			.addOrUpdateRunner(makeRunner({ id: "a", is_default: true }));
		const runners = useRunnersStore.getState().runners;
		expect(runners.map((r) => r.id)).toEqual(["a", "b"]);
		expect(runners[0].is_default).toBe(true);
	});

	it("removeRunner filters out by id", () => {
		useRunnersStore.setState({
			runners: [makeRunner({ id: "a" }), makeRunner({ id: "b" })],
		});
		useRunnersStore.getState().removeRunner("a");
		expect(useRunnersStore.getState().runners.map((r) => r.id)).toEqual(["b"]);
	});
});

describe("setDefaultRunner", () => {
	it("calls the action then flags only the matching runner as default", async () => {
		useRunnersStore.setState({
			runners: [
				makeRunner({ id: "a", is_default: true }),
				makeRunner({ id: "b", is_default: false }),
			],
		});
		setDefaultRunnerAction.mockResolvedValue(undefined);

		await useRunnersStore.getState().setDefaultRunner("b");

		expect(setDefaultRunnerAction).toHaveBeenCalledWith("b");
		const runners = useRunnersStore.getState().runners;
		expect(runners.find((r) => r.id === "a")?.is_default).toBe(false);
		expect(runners.find((r) => r.id === "b")?.is_default).toBe(true);
	});
});

describe("deployRunner / updateRunner / destroyRunner / deleteRunner", () => {
	it("deployRunner returns the action result and triggers a forced refetch", async () => {
		const result = { runnerId: "r1", jobId: "j1" };
		deployRunnerAction.mockResolvedValue(result);

		const ret = await useRunnersStore
			.getState()
			.deployRunner({ name: "x" } as never);

		expect(ret).toBe(result);
		expect(deployRunnerAction).toHaveBeenCalledWith({ name: "x" });
		// fetchRunners(true) fired (lastFetchedAt was null so it would run regardless)
		expect(getRunnersWithReleases).toHaveBeenCalled();
	});

	it("updateRunner forwards the id and returns the job id", async () => {
		updateRunnerAction.mockResolvedValue({ jobId: "job-9" });
		const ret = await useRunnersStore.getState().updateRunner("r-9");
		expect(updateRunnerAction).toHaveBeenCalledWith("r-9");
		expect(ret).toEqual({ jobId: "job-9" });
	});

	it("destroyRunner forwards both ids and returns the job id", async () => {
		destroyRunnerAction.mockResolvedValue({ jobId: "job-d" });
		const ret = await useRunnersStore
			.getState()
			.destroyRunner("r-1", "assigned-2");
		expect(destroyRunnerAction).toHaveBeenCalledWith("r-1", "assigned-2");
		expect(ret).toEqual({ jobId: "job-d" });
	});

	it("deleteRunner calls removeRunner action and refetches", async () => {
		removeRunnerAction.mockResolvedValue(undefined);
		await useRunnersStore.getState().deleteRunner("r-x");
		expect(removeRunnerAction).toHaveBeenCalledWith("r-x");
		expect(getRunnersWithReleases).toHaveBeenCalled();
	});
});

describe("updateAllOutdated", () => {
	it("tallies fulfilled vs rejected updates", async () => {
		updateRunnerAction
			.mockResolvedValueOnce({ jobId: "1" })
			.mockRejectedValueOnce(new Error("fail"))
			.mockResolvedValueOnce({ jobId: "3" });

		const ret = await useRunnersStore
			.getState()
			.updateAllOutdated(["a", "b", "c"]);

		expect(ret).toEqual({ queued: 2, failed: 1 });
		expect(updateRunnerAction).toHaveBeenCalledTimes(3);
	});

	it("returns zeroes for an empty id list without calling the action", async () => {
		const ret = await useRunnersStore.getState().updateAllOutdated([]);
		expect(ret).toEqual({ queued: 0, failed: 0 });
		expect(updateRunnerAction).not.toHaveBeenCalled();
	});
});

describe("fetchReleaseNotes", () => {
	it("delegates to getReleaseNotes and returns its value", async () => {
		const notes = { version: "9.9.9", release_notes: "hi" };
		getReleaseNotes.mockResolvedValue(notes as never);
		const ret = await useRunnersStore.getState().fetchReleaseNotes("9.9.9");
		expect(getReleaseNotes).toHaveBeenCalledWith("9.9.9");
		expect(ret).toBe(notes);
	});
});
