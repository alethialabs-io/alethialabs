// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// The runners domain's client half (#6123, ADR 0005). Reads go over the `runners.*` GET procedures
// and are kept current by the change stream (`runners` / `jobs` topics, lib/query/topics.ts) — no
// poll. Writes go through `useActionMutation`: pending state, a double-submit guard, one toast
// policy, and invalidation of every key that shows what changed.

import { useQuery } from "@tanstack/react-query";
import {
	deployRunnerAction,
	destroyRunnerAction,
	registerRunnerAction,
	removeRunnerAction,
	setDefaultRunnerAction,
	updateRunnerAction,
} from "@/app/server/actions/runners";
import { type ActionResult, type FieldErrors, ok } from "@/lib/actions/result";
import { useActionMutation } from "@/lib/actions/use-action-mutation";
import type {
	ProvisionJobStatus as PublicProvisionJobStatus,
	ProvisionJobType as PublicProvisionJobType,
} from "@/lib/db/schema";
import { TOPIC_KEYS } from "@/lib/query/topics";
import { orpc } from "@/lib/rpc/client";
import type { RunnerReleaseInfo, RunnersData, RunnerView } from "@/lib/rpc/procedures/runners";

export type { RunnerReleaseInfo, RunnersData, RunnerView };

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
 * Every runner the actor can see, the latest release and the changelog. Server-prefetched on the
 * runners route and hydrated; a heartbeat-driven ONLINE/OFFLINE flip arrives as a `runners` hint.
 */
export function useRunnersQuery() {
	return useQuery(orpc.runners.list.queryOptions());
}

/** Every key showing runner rows — the grid, the universe, the pools (they count managed runners). */
function runnerKeys() {
	return TOPIC_KEYS.runners();
}

/** A lifecycle action also queues a job: the job feeds show it, and the card joins it. */
function runnerAndJobKeys() {
	return [...TOPIC_KEYS.runners(), ...TOPIC_KEYS.jobs()];
}

/** Sets (or clears, with `null`) the default runner. */
export function useSetDefaultRunner() {
	return useActionMutation((runnerId: string | null) => setDefaultRunnerAction({ runnerId }), {
		invalidates: runnerKeys(),
	});
}

/** Deploys a new runner into a cloud account; a validation refusal goes to the form's fields. */
export function useDeployRunner(onValidationError?: (fields: FieldErrors) => void) {
	return useActionMutation(deployRunnerAction, { invalidates: runnerAndJobKeys(), onValidationError });
}

/** Registers a self-operated runner; a validation refusal goes to the form's fields. */
export function useRegisterRunner(onValidationError?: (fields: FieldErrors) => void) {
	return useActionMutation(registerRunnerAction, { invalidates: runnerKeys(), onValidationError });
}

/** Queues a version update for a single runner. */
export function useUpdateRunner() {
	return useActionMutation((runnerId: string) => updateRunnerAction({ runnerId }), {
		invalidates: runnerAndJobKeys(),
	});
}

/**
 * Queues an update for each outdated runner, and answers how many queued vs failed. One failed
 * runner does not fail the batch: the caller reports the split.
 */
async function updateEach(runnerIds: string[]): Promise<ActionResult<{ queued: number; failed: number }>> {
	const results = await Promise.allSettled(runnerIds.map((runnerId) => updateRunnerAction({ runnerId })));
	const queued = results.filter((r) => r.status === "fulfilled" && r.value.ok).length;
	return ok({ queued, failed: runnerIds.length - queued });
}

/** Queues updates for every outdated runner, reporting how many queued vs failed. */
export function useUpdateAllOutdated() {
	return useActionMutation(updateEach, { invalidates: runnerAndJobKeys() });
}

/** Destroys a runner's cloud resources (optionally on a chosen runner). */
export function useDestroyRunner() {
	return useActionMutation(
		(v: { runnerId: string; assignedRunnerId?: string | null }) => destroyRunnerAction(v),
		{ invalidates: runnerAndJobKeys() },
	);
}

/** Removes a runner record (after its resources are gone). */
export function useDeleteRunner() {
	return useActionMutation((runnerId: string) => removeRunnerAction({ runnerId }), {
		invalidates: runnerKeys(),
	});
}
