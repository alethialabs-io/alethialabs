"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { getEnvironmentComponentStatus } from "@/app/server/actions/component-status";
import {
	EMPTY_ENVIRONMENT_STATUS,
	type EnvironmentStatus,
} from "@/lib/canvas/component-status";
import { qk } from "./keys";

/** Poll fast while the environment is mid-change, slowly when it's settled. */
const POLL_IN_FLIGHT_MS = 4_000;
const POLL_SETTLED_MS = 30_000;

/**
 * The environment's live server status for the canvas — component lifecycles, the in-flight job,
 * drift, cost, cluster liveness, and (for a BYO IaC env) the module's architecture, in ONE
 * round-trip.
 *
 * The poll rate follows the environment: while a job is running the canvas is watching a deploy
 * happen, so it refetches every few seconds; once things settle it drops back to a slow heartbeat
 * rather than hammering the database forever.
 *
 * **`environmentId` is optional, and `null` is a legitimate value** — it means "this project's
 * default environment", which the server resolves itself (`resolveActiveEnvironmentId`). The caller
 * passes `searchParams.get("environment_id")`, which is null on every visit to a project that hasn't
 * explicitly switched environments — i.e. the common case, and the one you land on from the sidebar.
 *
 * This used to be gated on `!!projectId && !!environmentId`, so **on the default environment the
 * query never ran at all**, and everything it feeds was dead there: component status (a FAILED
 * database read "Ready"), the drift chips, the cost chip, and the BYO-IaC architecture. It only came
 * alive if the URL happened to carry an explicit `?environment_id=`. The server had always handled
 * the absent id — only this guard stood in the way.
 */
export function useEnvironmentStatusQuery(
	projectId: string | undefined,
	environmentId: string | null | undefined,
): UseQueryResult<EnvironmentStatus> {
	return useQuery({
		queryKey: qk.environmentStatus(projectId ?? "none", environmentId ?? null),
		queryFn: () => {
			// `enabled` guarantees a project below; this keeps the types honest without a cast.
			if (!projectId) return Promise.resolve(EMPTY_ENVIRONMENT_STATUS);
			return getEnvironmentComponentStatus(projectId, environmentId ?? null);
		},
		refetchInterval: (query) =>
			query.state.data?.activeJob ? POLL_IN_FLIGHT_MS : POLL_SETTLED_MS,
		// The create flow has no project yet — nothing to fetch. An absent ENVIRONMENT is NOT a
		// reason to skip: the server resolves it to the project's default.
		enabled: !!projectId,
	});
}
