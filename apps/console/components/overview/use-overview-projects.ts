"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { type UseQueryResult, keepPreviousData, useQuery } from "@tanstack/react-query";
import { orpc } from "@/lib/rpc/client";
import type { OverviewProjects } from "@/lib/rpc/procedures/overview";
import { retryUnlessRefused } from "@/lib/rpc/refusal";
import { type OverviewState, overviewProjectsInput } from "./overview-state";

/**
 * The overview grid's read (`overview.projects`, GET) for the address's state.
 *
 * It is a query, not props, because the grid changes without the viewer acting: a project is
 * created or duplicated, a deploy moves a status. Its key is listed under the `projects`,
 * `environments`, `jobs`, `addons` and `connectors` topics (`lib/query/topics.ts`), so a hint on
 * any of them refetches it while it is on screen. There is no interval.
 *
 * The route prefetches the same input (`overviewProjectsInput`), so the first paint has the rows.
 * While a changed search or filter is being answered the previous rows stay on screen
 * (`keepPreviousData`): the grid dims and does not fall back to its skeleton. An expected refusal is
 * not retried.
 */
export function useOverviewProjects(state: OverviewState): UseQueryResult<OverviewProjects> {
	return useQuery(
		orpc.overview.projects.queryOptions({
			input: overviewProjectsInput(state),
			retry: retryUnlessRefused,
			placeholderData: keepPreviousData,
		}),
	);
}
