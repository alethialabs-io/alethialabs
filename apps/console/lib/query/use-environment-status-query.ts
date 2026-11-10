"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { EnvironmentStatus } from "@/lib/canvas/component-status";
import { orpc } from "@/lib/rpc/client";

/**
 * The environment's live server status for the canvas — component lifecycles, the in-flight job,
 * drift, cost, cluster liveness, and (for a BYO IaC env) the module's architecture, in ONE
 * round-trip: the `canvas.environmentStatus` GET procedure (ADR 0005 D1, #6119).
 *
 * THE FIRST PAINT CARRIES IT. The Architecture page prefetches this exact key on the server
 * (`environmentStatusInput` below builds the input both sides use), so the board renders its node
 * statuses with the page instead of fetching after hydration.
 *
 * NO POLL. It used to refetch every 4 s while a job ran and every 30 s otherwise. A change to the
 * environment, its components, its add-ons or its jobs is now a hint on the org's change stream,
 * which invalidates this key (`lib/query/topics.ts`); while the stream is down the bus's one
 * fallback poll covers it (`lib/realtime/client/fallback-poll.ts`).
 *
 * **`environmentId` may be null** — it means "this project's default environment", which the server
 * resolves itself. The page passes the environment it resolved, so the key the server prefetched is
 * the key the client reads.
 */
export function useEnvironmentStatusQuery(
	projectId: string | undefined,
	environmentId: string | null | undefined,
): UseQueryResult<EnvironmentStatus> {
	return useQuery({
		...orpc.canvas.environmentStatus.queryOptions({
			input: environmentStatusInput(projectId ?? "", environmentId),
		}),
		// The create flow has no project yet — nothing to fetch. An absent ENVIRONMENT is NOT a
		// reason to skip: the server resolves it to the project's default.
		enabled: !!projectId,
	});
}

/** The `canvas.*` environment-scoped input for a project and (maybe) an environment. */
export function environmentStatusInput(
	projectId: string,
	environmentId: string | null | undefined,
): { projectId: string; environmentId: string | null } {
	return { projectId, environmentId: environmentId ?? null };
}
