// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { getClusters, type ClusterData } from "@/app/server/actions/clusters";
import { qk } from "./keys";

/**
 * Provisioned clusters for the active org. Polls every 5s while the tab is focused
 * (TanStack Query pauses the interval in the background) — the interim reconciliation
 * cadence until an SSE/LISTEN stream replaces it.
 */
export function useClustersQuery(): UseQueryResult<ClusterData[]> {
	const { org } = useParams<{ org: string }>();
	return useQuery({
		queryKey: qk.clusters(org),
		queryFn: () => getClusters(),
		refetchInterval: 5_000,
	});
}
