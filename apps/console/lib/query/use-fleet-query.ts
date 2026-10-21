// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// The warm pools' client half (#6123, ADR 0005). The read is the `runners.fleet` GET procedure,
// prefetched by the runners route and kept current by the change stream: a pool's config is a
// `fleet` hint, its runners' states are `runners` hints, its busy count moves with `jobs` hints
// (lib/query/topics.ts) — no poll. Writes go through `useActionMutation`.

import { useQuery } from "@tanstack/react-query";
import { retryUnlessRefused } from "@/components/overview/overview-reads";
import {
	createFleetPoolAction,
	deleteFleetPoolAction,
	setFleetPoolEnabledAction,
	updateFleetPoolAction,
} from "@/app/server/actions/fleet";
import { useActionMutation } from "@/lib/actions/use-action-mutation";
import { TOPIC_KEYS } from "@/lib/query/topics";
import { orpc } from "@/lib/rpc/client";
import type { FleetData } from "@/lib/rpc/procedures/runners";

export type { FleetData };

/** The warm pools and, for a manager, their editable rows. Server-prefetched on the runners route. */
export function useFleetQuery() {
	return useQuery(orpc.runners.fleet.queryOptions({ retry: retryUnlessRefused }));
}

/** The pools' month-to-date economics; null unless the viewer manages the fleet. Prefetched too. */
export function useFleetEconomicsQuery() {
	return useQuery(orpc.runners.fleetEconomics.queryOptions());
}

/** The fleet read's key, for the optimistic patches below. */
function fleetKey() {
	return orpc.runners.fleet.queryKey();
}

/** Narrows a cache value to the fleet read's shape (it is the only thing stored under its key). */
function isFleetData(value: unknown): value is FleetData {
	return typeof value === "object" && value !== null && "pools" in value && Array.isArray(value.pools);
}

/** Creates a warm pool. */
export function useCreatePool() {
	return useActionMutation(createFleetPoolAction, { invalidates: TOPIC_KEYS.fleet() });
}

/** Updates a warm pool's knobs. */
export function useUpdatePool() {
	return useActionMutation(updateFleetPoolAction, { invalidates: TOPIC_KEYS.fleet() });
}

/** Pauses/resumes a pool. Optimistically flips the toggle so it feels instant; rolled back on failure. */
export function useSetPoolEnabled() {
	return useActionMutation(setFleetPoolEnabledAction, {
		invalidates: TOPIC_KEYS.fleet(),
		optimistic: [
			{
				key: fleetKey(),
				update: (current, { id, enabled }) =>
					isFleetData(current)
						? { ...current, pools: current.pools.map((p) => (p.id === id ? { ...p, enabled } : p)) }
						: current,
			},
		],
	});
}

/** Deletes a pool. Optimistically removes the card, reconciling on settle. */
export function useDeletePool() {
	return useActionMutation(deleteFleetPoolAction, {
		invalidates: TOPIC_KEYS.fleet(),
		successMessage: "Pool deleted",
		optimistic: [
			{
				key: fleetKey(),
				update: (current, { id }) =>
					isFleetData(current) ? { ...current, pools: current.pools.filter((p) => p.id !== id) } : current,
			},
		],
	});
}
