// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Unit test for the projects zustand store (lib/stores/use-projects-store.ts). The only boundary is
// the server-action module @/app/server/actions/projects (getProjects) — everything else (the
// stale/in-flight/force guards of fetchProjects, the favorite Set toggle, the
// remove/update-in-place reducers, and the sessionStorage-persisted partialize) is the real store.
// We drive actions via getState() and assert resulting state + which mock was called with what.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/server/actions/projects", () => ({ getProjects: vi.fn() }));

import { useProjectsStore } from "@/lib/stores/use-projects-store";
import {
	getProjects,
	type ProjectWithProvider,
} from "@/app/server/actions/projects";

const mockGetProjects = vi.mocked(getProjects);

/** Build a project row fixture; only the id field the store touches is meaningful. */
function project(
	id: string,
	over: Record<string, unknown> = {},
): ProjectWithProvider {
	return { id, name: `proj-${id}`, ...over } as never;
}

// A fresh, deterministic starting point for every test (the store is a module singleton).
const INITIAL = {
	projects: [],
	isLoading: false,
	error: null,
	lastFetchedAt: null,
	favoriteProjectIds: [],
} as const;

beforeEach(() => {
	vi.clearAllMocks();
	sessionStorage.clear();
	useProjectsStore.setState({ ...INITIAL } as never, false);
	mockGetProjects.mockResolvedValue([] as never);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("fetchProjects", () => {
	it("loads projects and records lastFetchedAt on success", async () => {
		const rows = [project("a"), project("b")];
		mockGetProjects.mockResolvedValueOnce(rows as never);

		const before = Date.now();
		await useProjectsStore.getState().fetchProjects();
		const s = useProjectsStore.getState();

		expect(mockGetProjects).toHaveBeenCalledTimes(1);
		expect(s.projects).toBe(rows);
		expect(s.isLoading).toBe(false);
		expect(s.error).toBeNull();
		expect(s.lastFetchedAt).toBeGreaterThanOrEqual(before);
	});

	it("is a no-op while a fetch is already in flight", async () => {
		useProjectsStore.setState({ isLoading: true } as never, false);

		await useProjectsStore.getState().fetchProjects(true);

		expect(mockGetProjects).not.toHaveBeenCalled();
	});

	it("skips the fetch when cached data is still fresh", async () => {
		useProjectsStore.setState({ lastFetchedAt: Date.now() } as never, false);

		await useProjectsStore.getState().fetchProjects();

		expect(mockGetProjects).not.toHaveBeenCalled();
	});

	it("force=true bypasses the stale-threshold guard", async () => {
		useProjectsStore.setState({ lastFetchedAt: Date.now() } as never, false);

		await useProjectsStore.getState().fetchProjects(true);

		expect(mockGetProjects).toHaveBeenCalledTimes(1);
	});

	it("refetches once the cache is older than the 30s stale threshold", async () => {
		useProjectsStore.setState(
			{ lastFetchedAt: Date.now() - 31_000 } as never,
			false,
		);

		await useProjectsStore.getState().fetchProjects();

		expect(mockGetProjects).toHaveBeenCalledTimes(1);
	});

	it("captures the error message and clears loading on failure", async () => {
		mockGetProjects.mockRejectedValueOnce(new Error("boom"));

		await useProjectsStore.getState().fetchProjects();
		const s = useProjectsStore.getState();

		expect(s.isLoading).toBe(false);
		expect(s.error).toBe("boom");
		expect(s.projects).toEqual([]);
	});

	it("falls back to a generic message for non-Error rejections", async () => {
		mockGetProjects.mockRejectedValueOnce("oops");

		await useProjectsStore.getState().fetchProjects();

		expect(useProjectsStore.getState().error).toBe("Failed to fetch projects");
	});

	it("clears a prior error when a subsequent fetch succeeds", async () => {
		useProjectsStore.setState({ error: "old failure" } as never, false);
		mockGetProjects.mockResolvedValueOnce([project("x")] as never);

		await useProjectsStore.getState().fetchProjects(true);

		expect(useProjectsStore.getState().error).toBeNull();
	});
});

describe("toggleFavorite", () => {
	it("adds an id when it is not yet favorited", () => {
		useProjectsStore.getState().toggleFavorite("p1");
		expect(useProjectsStore.getState().favoriteProjectIds).toEqual(["p1"]);
	});

	it("removes an id when it is already favorited", () => {
		useProjectsStore.setState(
			{ favoriteProjectIds: ["p1", "p2"] } as never,
			false,
		);

		useProjectsStore.getState().toggleFavorite("p1");

		expect(useProjectsStore.getState().favoriteProjectIds).toEqual(["p2"]);
	});

	it("does not duplicate an id across two toggles (set semantics)", () => {
		useProjectsStore.getState().toggleFavorite("p1");
		useProjectsStore.getState().toggleFavorite("p2");
		useProjectsStore.getState().toggleFavorite("p1"); // removes p1 again

		expect(useProjectsStore.getState().favoriteProjectIds).toEqual(["p2"]);
	});

	it("persists favoriteProjectIds (and only those) to sessionStorage", () => {
		useProjectsStore.setState({ projects: [project("a")] } as never, false);
		useProjectsStore.getState().toggleFavorite("p1");

		const persisted = JSON.parse(sessionStorage.getItem("projects-store") ?? "{}");
		expect(persisted.state).toEqual({ favoriteProjectIds: ["p1"] });
		// partialize must NOT leak the in-memory projects array into storage.
		expect(persisted.state.projects).toBeUndefined();
	});
});

describe("removeProject", () => {
	it("filters out the matching project by id, leaving others intact", () => {
		useProjectsStore.setState(
			{ projects: [project("a"), project("b"), project("c")] } as never,
			false,
		);

		useProjectsStore.getState().removeProject("b");

		expect(
			useProjectsStore.getState().projects.map((p) => p.id),
		).toEqual(["a", "c"]);
	});

	it("is a no-op when no project matches the id", () => {
		useProjectsStore.setState(
			{ projects: [project("a")] } as never,
			false,
		);

		useProjectsStore.getState().removeProject("missing");

		expect(useProjectsStore.getState().projects.map((p) => p.id)).toEqual(["a"]);
	});
});

describe("updateProjectInPlace", () => {
	it("patches only the matching project's fields, preserving the rest", () => {
		useProjectsStore.setState(
			{
				projects: [
					project("a", { name: "old-a" }),
					project("b", { name: "old-b" }),
				],
			} as never,
			false,
		);

		useProjectsStore
			.getState()
			.updateProjectInPlace("a", { name: "new-a" } as never);
		const projects = useProjectsStore.getState().projects as unknown as Array<{ id: string; name: string }>;

		expect(projects.find((p) => p.id === "a")?.name).toBe("new-a");
		expect(projects.find((p) => p.id === "b")?.name).toBe("old-b");
	});

	it("leaves all projects untouched when no id matches", () => {
		const rows = [project("a", { name: "keep" })];
		useProjectsStore.setState({ projects: rows } as never, false);

		useProjectsStore
			.getState()
			.updateProjectInPlace("nope", { name: "changed" } as never);

		expect((useProjectsStore.getState().projects[0] as unknown as { name: string }).name).toBe("keep");
	});
});
