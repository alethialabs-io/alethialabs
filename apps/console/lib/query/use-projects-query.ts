// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import {
	useQuery,
	useQueryClient,
	type UseQueryResult,
} from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { useCallback } from "react";
import {
	getProjects,
	type ProjectWithProvider,
} from "@/app/server/actions/projects";
import { qk } from "./keys";

/**
 * The org's projects (flat under the org). Server-prefetched and hydrated, then shared
 * across the overview grid, project switcher, breadcrumbs, command palette, and activity
 * log — TanStack Query dedupes them to a single request keyed by org.
 */
export function useProjectsQuery(): UseQueryResult<ProjectWithProvider[]> {
	const { org } = useParams<{ org: string }>();
	return useQuery({
		queryKey: qk.projects(org),
		queryFn: () => getProjects(),
	});
}

/**
 * Returns a callback that invalidates the projects cache, forcing a refetch — used after
 * mutations (create/duplicate/delete) so every projects surface reconciles.
 */
export function useRefreshProjects(): () => void {
	const qc = useQueryClient();
	const { org } = useParams<{ org: string }>();
	return useCallback(() => {
		void qc.invalidateQueries({ queryKey: qk.projects(org) });
	}, [qc, org]);
}
