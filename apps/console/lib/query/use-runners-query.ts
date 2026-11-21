// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// The runners domain's client half (#6123, ADR 0005). Reads go over the `runners.*` GET procedures
// and are kept current by the change stream (`runners` / `jobs` topics, lib/query/topics.ts) — no
// poll. Writes go through `useActionMutation`: pending state, a double-submit guard, one toast
// policy, and invalidation of every key that shows what changed.

import { useQuery } from "@tanstack/react-query";
import { retryUnlessRefused } from "@/components/overview/overview-reads";
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
import { TOPIC_KEYS } from "@/lib/query/topics";
import { orpc } from "@/lib/rpc/client";
import type { RunnerReleaseInfo, RunnersData, RunnerView } from "@/lib/rpc/procedures/runners";

export type { RunnerReleaseInfo, RunnersData, RunnerView };

/**
 * Every runner the actor can see, the latest release and the changelog. Server-prefetched on the
 * runners route and hydrated; a heartbeat-driven ONLINE/OFFLINE flip arrives as a `runners` hint.
 */
export function useRunnersQuery() {
	return useQuery(orpc.runners.list.queryOptions({ retry: retryUnlessRefused }));
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

/** A runner an "Update all" batch names: its id to act on, its name to report. */
export interface RunnerRef {
	id: string;
	name: string;
}

/** Each runner of an "Update all" batch, sorted by whether its update job was queued. */
export interface UpdateEachOutcome {
	queued: RunnerRef[];
	failed: RunnerRef[];
}

/**
 * Queues an update for each outdated runner and answers WHICH were queued and which were not, in
 * the order they were given. One failed runner does not fail the batch: a refusal, a network
 * failure or a throw for one runner puts that runner in `failed`, and the caller names them.
 */
export async function updateEach(batch: RunnerRef[]): Promise<ActionResult<UpdateEachOutcome>> {
	const results = await Promise.allSettled(batch.map((r) => updateRunnerAction({ runnerId: r.id })));
	const queued: RunnerRef[] = [];
	const failed: RunnerRef[] = [];
	results.forEach((result, i) => {
		const runner = batch[i];
		if (result.status === "fulfilled" && result.value.ok) queued.push(runner);
		else failed.push(runner);
	});
	return ok({ queued, failed });
}

/** Queues updates for every outdated runner, reporting which were queued and which were not. */
export function useUpdateAllOutdated() {
	return useActionMutation(updateEach, { invalidates: runnerAndJobKeys() });
}

/**
 * The verified cloud accounts a runner can be deployed into, on the clouds we hold runner templates
 * for (the `runners.deployableAccounts` read). Read while the Add-runner sheet is open; a cached
 * answer renders at once and is re-read each time the sheet opens (`staleTime: 0`), so an account
 * connected meanwhile appears.
 */
export function useDeployableAccountsQuery(open: boolean) {
	return useQuery(
		orpc.runners.deployableAccounts.queryOptions({ enabled: open, staleTime: 0, retry: retryUnlessRefused }),
	);
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
