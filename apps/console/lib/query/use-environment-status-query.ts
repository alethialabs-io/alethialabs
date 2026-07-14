"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { getEnvironmentComponentStatus } from "@/app/server/actions/component-status";
import type { EnvironmentStatus } from "@/lib/canvas/component-status";
import { qk } from "./keys";

/** Poll fast while the environment is mid-change, slowly when it's settled. */
const POLL_IN_FLIGHT_MS = 4_000;
const POLL_SETTLED_MS = 30_000;

/**
 * The environment's live server status for the canvas — component lifecycles, the in-flight job,
 * drift, and cluster liveness in one round-trip.
 *
 * The poll rate follows the environment: while a job is running the canvas is watching a deploy
 * happen, so it refetches every few seconds; once things settle it drops back to a slow heartbeat
 * rather than hammering the database forever.
 */
export function useEnvironmentStatusQuery(
	projectId: string | undefined,
	environmentId: string | null | undefined,
): UseQueryResult<EnvironmentStatus> {
	return useQuery({
		queryKey: qk.environmentStatus(projectId ?? "none", environmentId),
		queryFn: () =>
			getEnvironmentComponentStatus(projectId as string, environmentId as string),
		refetchInterval: (query) =>
			query.state.data?.activeJob ? POLL_IN_FLIGHT_MS : POLL_SETTLED_MS,
		// The create flow has no project or environment yet — there is no server status to fetch.
		enabled: !!projectId && !!environmentId,
	});
}
