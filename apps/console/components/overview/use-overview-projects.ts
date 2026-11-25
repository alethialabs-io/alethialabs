"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import type { ProjectListItem } from "@/app/server/actions/projects";
import { MANAGE_DENIED_REASON, MANAGE_PENDING_REASON } from "@/components/errors/manage-gate";
import { KEYSET_MAX_LIMIT } from "@/lib/queries/keyset";
import type { ProjectsFacets, ProjectsPage } from "@/lib/queries/projects";
import { type KeysetList, useKeysetList } from "@/lib/query/use-keyset-list";
import { orpc } from "@/lib/rpc/client";
import type { OverviewProjectsSummary } from "@/lib/rpc/procedures/overview";
import { retryUnlessRefused } from "@/lib/rpc/refusal";
import { type OverviewState, overviewProjectsInput } from "./overview-state";

/**
 * The overview grid's walk (`overview.projects.page`) for the address's state, one keyset page at a
 * time (LST-4 #7486). The key is the address's search, filters and sort alone — the cursor is the
 * infinite query's page param, never in the key or the URL — so a changed filter restarts at page
 * one, and the route's prefetch of the first page (`app/(private)/[org]/page.tsx`) hydrates it.
 *
 * Live: every topic that names `orpc.overview.projects.key()` (`lib/query/topics.ts`) reaches it.
 * While a changed search or filter is being answered the previous rows stay on screen and
 * `isPlaceholderData` dims them; a failed later page keeps the rows and `ListFooter` says so.
 */
export function useOverviewProjects(state: OverviewState): KeysetList<ProjectListItem, ProjectsFacets> {
	return useKeysetList(orpc.overview.projects.page, overviewProjectsInput(state));
}

/**
 * The grid's summary (`overview.projects.summary`): the organization's project count for the Usage
 * card, the connected and offered clouds, and whether the viewer may create a project. An expected
 * refusal is not retried.
 */
export function useOverviewProjectsSummary(): UseQueryResult<OverviewProjectsSummary> {
	return useQuery(orpc.overview.projects.summary.queryOptions({ retry: retryUnlessRefused }));
}

/**
 * The viewer's starred projects that match the address's search and filters, in its sort — the
 * same builder as the walk, asked by id (`ids`). Favourites live in the browser, so they cannot be
 * part of the walk's key (the server's prefetch would never match it); this second, bounded read
 * lets a starred project lead the grid whichever page the walk would have reached it on.
 *
 * Bounded at one maximum page: past {@link KEYSET_MAX_LIMIT} stars the rest are not asked, and keep
 * their place in the walk. No `keepPreviousData`: a previous answer belongs to other filters, and
 * {@link starredFirst} falls back to the loaded rows while this one is in flight.
 */
export function useStarredProjects(state: OverviewState, favoriteIds: readonly string[]): UseQueryResult<ProjectsPage> {
	const ids = [...favoriteIds].sort().slice(0, KEYSET_MAX_LIMIT);
	return useQuery(
		orpc.overview.projects.page.queryOptions({
			input: { ...overviewProjectsInput(state), ids, limit: KEYSET_MAX_LIMIT },
			enabled: ids.length > 0,
			retry: retryUnlessRefused,
		}),
	);
}

/**
 * The grid's rows, starred first. With the starred lookup's answer: those projects (in the server's
 * order), then the walk's rows without them, so none is drawn twice. Before it has answered, or
 * when it failed: a stable reorder of the rows loaded so far, as the grid always did.
 */
export function starredFirst<Row extends { id: string }>(
	rows: readonly Row[],
	favoriteIds: readonly string[],
	starred: readonly Row[] | undefined,
): Row[] {
	if (favoriteIds.length === 0) return [...rows];
	const favorites = new Set(favoriteIds);
	if (starred === undefined) {
		return [...rows.filter((row) => favorites.has(row.id)), ...rows.filter((row) => !favorites.has(row.id))];
	}
	const lead = starred.filter((row) => favorites.has(row.id));
	const shown = new Set(lead.map((row) => row.id));
	return [...lead, ...rows.filter((row) => !shown.has(row.id))];
}

/**
 * Why the viewer cannot create a project yet, or `null` when they can. Disabled with a reason until
 * the server has said the viewer may; a read that FAILED says nothing either way, so the entry is
 * left usable and `~/new` decides for itself.
 */
export function createProjectReason(summary: UseQueryResult<OverviewProjectsSummary>): string | null {
	if (summary.data === undefined) return summary.isError ? null : MANAGE_PENDING_REASON;
	return summary.data.canCreate ? null : MANAGE_DENIED_REASON;
}
