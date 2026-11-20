// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The overview grid's state as the address carries it, and the read input built from it. No
// "use client" and no server imports: the route (`app/(private)/[org]/page.tsx`) and the browser
// both build the grid's read from here, and the two must produce the same query key or the
// server's answer does not hydrate.

import type { ViewMode } from "@repo/ui/view-toggle";

/** The grid's search, filters, sort and view. Mirrored 1:1 into the URL search params. */
export interface OverviewState {
	q: string;
	clouds: string[];
	repos: string[];
	sort: "activity" | "name";
	view: ViewMode;
}

/** The raw search params the grid's state is read from. All optional. */
export interface OverviewSearchParams {
	q?: string;
	cloud?: string;
	repo?: string;
	sort?: string;
	view?: string;
}

/** The input of the grid's read (`overview.projects`): the state without the view. */
export interface OverviewProjectsQueryInput {
	q: string;
	clouds: string[];
	repos: string[];
	sort: "activity" | "name";
}

// The read router's bounds on the grid's input (`lib/rpc/procedures/overview.ts`). The address is
// cut to them here, so a long or hand-edited link narrows the grid and never fails its read.
const MAX_QUERY = 200;
const MAX_CLOUDS = 32;
const MAX_CLOUD = 64;
const MAX_REPOS = 64;
const MAX_REPO = 2048;

/** Splits a comma-separated param into trimmed, non-empty items within `maxItem` and `maxItems`. */
function toList(value: string | undefined, maxItem: number, maxItems: number): string[] {
	return (value ?? "")
		.split(",")
		.map((item) => item.trim())
		.filter((item) => item.length > 0 && item.length <= maxItem)
		.slice(0, maxItems);
}

/** The grid's state for an address. Anything the address does not say takes its default. */
export function toOverviewState(params: OverviewSearchParams): OverviewState {
	return {
		q: (params.q ?? "").slice(0, MAX_QUERY),
		clouds: toList(params.cloud, MAX_CLOUD, MAX_CLOUDS),
		repos: toList(params.repo, MAX_REPO, MAX_REPOS),
		sort: params.sort === "name" ? "name" : "activity",
		view: params.view === "table" ? "table" : "card",
	};
}

/**
 * The search string for a state. Only non-default values are written, so a pristine grid keeps a
 * clean `/{org}` address. Empty when nothing differs from the defaults.
 */
export function overviewSearch(state: OverviewState): string {
	const params = new URLSearchParams();
	if (state.q) params.set("q", state.q);
	if (state.clouds.length) params.set("cloud", state.clouds.join(","));
	if (state.repos.length) params.set("repo", state.repos.join(","));
	if (state.sort !== "activity") params.set("sort", state.sort);
	if (state.view !== "card") params.set("view", state.view);
	return params.toString();
}

/** The grid read's input for a state. The view is presentation and is not part of the read. */
export function overviewProjectsInput(state: OverviewState): OverviewProjectsQueryInput {
	return { q: state.q, clouds: state.clouds, repos: state.repos, sort: state.sort };
}

/** Whether the state narrows the grid: a search or a filter is set. Sort and view do not narrow. */
export function isFiltered(state: OverviewState): boolean {
	return Boolean(state.q) || state.clouds.length > 0 || state.repos.length > 0;
}
