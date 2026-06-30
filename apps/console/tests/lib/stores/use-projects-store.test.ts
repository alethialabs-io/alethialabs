// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Unit test for the projects favorites store (lib/stores/use-projects-store.ts). The
// projects data now lives in TanStack Query (useProjectsQuery); this store only holds the
// persisted favorite ids, so the tests cover the favorite Set toggle and the
// sessionStorage-persisted partialize.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useProjectsStore } from "@/lib/stores/use-projects-store";

const INITIAL = { favoriteProjectIds: [] } as const;

beforeEach(() => {
	vi.clearAllMocks();
	sessionStorage.clear();
	useProjectsStore.setState({ ...INITIAL } as never, false);
});

afterEach(() => {
	vi.restoreAllMocks();
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

	it("persists favoriteProjectIds to sessionStorage", () => {
		useProjectsStore.getState().toggleFavorite("p1");

		const persisted = JSON.parse(sessionStorage.getItem("projects-store") ?? "{}");
		expect(persisted.state).toEqual({ favoriteProjectIds: ["p1"] });
	});
});
