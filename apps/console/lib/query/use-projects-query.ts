// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { ProjectWithProvider } from "@/app/server/actions/projects";
import { orpc } from "@/lib/rpc/client";

/**
 * The org's projects (flat under the org), over the read router's `workspace.projects` (GET).
 * The `[org]` layout prefetches it, so the project switcher, breadcrumbs, command palette and
 * activity log render it on first paint and share one cache entry. The org is the browser cache's
 * partition (`lib/query/client.ts`), so the key needs none of its own.
 */
export function useProjectsQuery(): UseQueryResult<ProjectWithProvider[]> {
	return useQuery(orpc.workspace.projects.queryOptions());
}
