// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import {
	useMutation,
	useQuery,
	useQueryClient,
	type UseQueryResult,
} from "@tanstack/react-query";
import { useParams } from "next/navigation";
import {
	deployRunner as deployRunnerAction,
	destroyRunner as destroyRunnerAction,
	removeRunner as removeRunnerAction,
	setDefaultRunner as setDefaultRunnerAction,
	updateRunner as updateRunnerAction,
} from "@/app/server/actions/runners";
import type {
	ProvisionJobStatus as PublicProvisionJobStatus,
	ProvisionJobType as PublicProvisionJobType,
} from "@/lib/db/schema";
import {
	fetchRunnersData,
	type RunnersData,
	type RunnerReleaseInfo,
	type RunnerWithRelease,
} from "./resource-fetchers";
import { qk } from "./keys";

export type { RunnersData, RunnerReleaseInfo, RunnerWithRelease };

export interface ActiveJob {
	id: string;
	job_type: PublicProvisionJobType;
	status: PublicProvisionJobStatus;
	config_snapshot: Record<string, unknown>;
	runner_id: string | null;
	project_id: string | null;
	projects: { project_name: string } | null;
}

/**
 * Runners + latest release for the active org. Server-prefetched and hydrated, then
 * polled every 10s while the tab is focused for heartbeat-driven ONLINE/OFFLINE changes.
 */
export function useRunnersQuery(): UseQueryResult<RunnersData> {
	const { org } = useParams<{ org: string }>();
	return useQuery({
		queryKey: qk.runners(org),
		queryFn: fetchRunnersData,
		refetchInterval: 10_000,
	});
}

/** Invalidates the runners cache so the list reflects a mutation's result on next reconcile. */
function useInvalidateRunners() {
	const qc = useQueryClient();
	const { org } = useParams<{ org: string }>();
	return () => qc.invalidateQueries({ queryKey: qk.runners(org) });
}

/** Sets (or clears) the default runner. */
export function useSetDefaultRunner() {
	const invalidate = useInvalidateRunners();
	return useMutation({
		mutationFn: (runnerId: string | null) => setDefaultRunnerAction(runnerId),
		onSuccess: () => invalidate(),
	});
}

/** Deploys a new runner into a cloud account. */
export function useDeployRunner() {
	const invalidate = useInvalidateRunners();
	return useMutation({
		mutationFn: (params: Parameters<typeof deployRunnerAction>[0]) =>
			deployRunnerAction(params),
		onSuccess: () => invalidate(),
	});
}

/** Queues a version update for a single runner. */
export function useUpdateRunner() {
	const invalidate = useInvalidateRunners();
	return useMutation({
		mutationFn: (runnerId: string) => updateRunnerAction(runnerId),
		onSuccess: () => invalidate(),
	});
}

/** Queues updates for every outdated runner, reporting how many queued vs failed. */
export function useUpdateAllOutdated() {
	const invalidate = useInvalidateRunners();
	return useMutation({
		mutationFn: async (runnerIds: string[]) => {
			const results = await Promise.allSettled(
				runnerIds.map((id) => updateRunnerAction(id)),
			);
			let queued = 0;
			let failed = 0;
			for (const r of results) {
				if (r.status === "fulfilled") queued++;
				else failed++;
			}
			return { queued, failed };
		},
		onSuccess: () => invalidate(),
	});
}

/** Destroys a runner's cloud resources (optionally reassigning its jobs). */
export function useDestroyRunner() {
	const invalidate = useInvalidateRunners();
	return useMutation({
		mutationFn: ({
			runnerId,
			assignedRunnerId,
		}: {
			runnerId: string;
			assignedRunnerId?: string | null;
		}) => destroyRunnerAction(runnerId, assignedRunnerId),
		onSuccess: () => invalidate(),
	});
}

/** Removes a runner record (after its resources are gone). */
export function useDeleteRunner() {
	const invalidate = useInvalidateRunners();
	return useMutation({
		mutationFn: (runnerId: string) => removeRunnerAction(runnerId),
		onSuccess: () => invalidate(),
	});
}
