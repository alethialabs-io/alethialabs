// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Unit test for the projects favourites store (lib/stores/use-projects-store.ts). The projects
// themselves live in TanStack Query; this store holds only which ones each person starred, kept in
// localStorage so a star is still there in a new tab (#6817).

import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import {
	PROJECTS_FAVORITES_STORAGE_KEY,
	useFavoriteProjectIds,
	useProjectsStore,
} from "@/lib/stores/use-projects-store";

/** The stars `userId` holds, read straight off the store. */
function starsOf(userId: string): string[] | undefined {
	return useProjectsStore.getState().favoritesByUser[userId];
}

beforeEach(() => {
	localStorage.clear();
	sessionStorage.clear();
	useProjectsStore.setState({ favoritesByUser: {} });
});

describe("toggleFavorite", () => {
	it("adds an id when it is not yet starred", () => {
		useProjectsStore.getState().toggleFavorite("u1", "p1");
		expect(starsOf("u1")).toEqual(["p1"]);
	});

	it("removes an id when it is already starred", () => {
		useProjectsStore.setState({ favoritesByUser: { u1: ["p1", "p2"] } });
		useProjectsStore.getState().toggleFavorite("u1", "p1");
		expect(starsOf("u1")).toEqual(["p2"]);
	});

	it("does not duplicate an id across two toggles (set semantics)", () => {
		useProjectsStore.getState().toggleFavorite("u1", "p1");
		useProjectsStore.getState().toggleFavorite("u1", "p2");
		useProjectsStore.getState().toggleFavorite("u1", "p1"); // removes p1 again
		expect(starsOf("u1")).toEqual(["p2"]);
	});

	it("keeps each person's stars apart on one browser", () => {
		useProjectsStore.getState().toggleFavorite("u1", "p1");
		useProjectsStore.getState().toggleFavorite("u2", "p2");
		expect(starsOf("u1")).toEqual(["p1"]);
		expect(starsOf("u2")).toEqual(["p2"]);
	});
});

describe("persistence", () => {
	it("writes the stars to localStorage, so a new tab has them, and nothing to sessionStorage", () => {
		useProjectsStore.getState().toggleFavorite("u1", "p1");
		const persisted = JSON.parse(localStorage.getItem(PROJECTS_FAVORITES_STORAGE_KEY) ?? "{}");
		expect(persisted.state).toEqual({ favoritesByUser: { u1: ["p1"] } });
		expect(sessionStorage.length).toBe(0);
	});

	it("a new tab reads them back: rehydrating from localStorage restores the stars", async () => {
		localStorage.setItem(
			PROJECTS_FAVORITES_STORAGE_KEY,
			JSON.stringify({ state: { favoritesByUser: { u1: ["p9"] } }, version: 1 }),
		);
		await useProjectsStore.persist.rehydrate();
		expect(starsOf("u1")).toEqual(["p9"]);
	});
});

describe("useFavoriteProjectIds", () => {
	it("answers the signed-in person's stars, and nobody else's", () => {
		useProjectsStore.setState({ favoritesByUser: { u1: ["p1"], u2: ["p2"] } });
		expect(renderHook(() => useFavoriteProjectIds("u1")).result.current).toEqual(["p1"]);
		expect(renderHook(() => useFavoriteProjectIds("u3")).result.current).toEqual([]);
	});

	it("answers nothing while nobody is signed in", () => {
		useProjectsStore.setState({ favoritesByUser: { u1: ["p1"] } });
		expect(renderHook(() => useFavoriteProjectIds(null)).result.current).toEqual([]);
	});

	it("hands back one array for somebody with no stars, so a render that reads it does not loop", () => {
		const { result, rerender } = renderHook(() => useFavoriteProjectIds("u3"));
		const first = result.current;
		rerender();
		expect(result.current).toBe(first);
	});
});
