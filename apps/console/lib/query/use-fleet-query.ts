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
	createFleetPool,
	deleteFleetPool,
	setFleetPoolEnabled,
	updateFleetPool,
} from "@/app/server/actions/fleet";
import type {
	FleetPoolCreateInput,
	FleetPoolUpdateInput,
} from "@/lib/validations/fleet";
import { fetchFleetData, type FleetData } from "./resource-fetchers";
import { qk } from "./keys";

export type { FleetData };

/**
 * Fleet cockpit data (warm pools + economics) for the active org. Server-prefetched and
 * hydrated, then polled every 10s so the cards track the controller's reconcile loop.
 */
export function useFleetQuery(): UseQueryResult<FleetData> {
	const { org } = useParams<{ org: string }>();
	return useQuery({
		queryKey: qk.fleet(org),
		queryFn: fetchFleetData,
		refetchInterval: 10_000,
	});
}

/** Invalidates the fleet cache so the pools reflect a mutation on the next reconcile. */
function useInvalidateFleet() {
	const qc = useQueryClient();
	const { org } = useParams<{ org: string }>();
	return () => qc.invalidateQueries({ queryKey: qk.fleet(org) });
}

/** Creates a warm pool. */
export function useCreatePool() {
	const invalidate = useInvalidateFleet();
	return useMutation({
		mutationFn: (input: FleetPoolCreateInput) => createFleetPool(input),
		onSuccess: () => invalidate(),
	});
}

/** Updates a warm pool's knobs. */
export function useUpdatePool() {
	const invalidate = useInvalidateFleet();
	return useMutation({
		mutationFn: ({ id, input }: { id: string; input: FleetPoolUpdateInput }) =>
			updateFleetPool(id, input),
		onSuccess: () => invalidate(),
	});
}

/** Pauses/resumes a pool. Optimistically flips the toggle so it feels instant. */
export function useSetPoolEnabled() {
	const qc = useQueryClient();
	const { org } = useParams<{ org: string }>();
	return useMutation({
		mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
			setFleetPoolEnabled(id, enabled),
		onMutate: async ({ id, enabled }) => {
			await qc.cancelQueries({ queryKey: qk.fleet(org) });
			const prev = qc.getQueryData<FleetData>(qk.fleet(org));
			if (prev) {
				qc.setQueryData<FleetData>(qk.fleet(org), {
					...prev,
					pools: prev.pools.map((p) => (p.id === id ? { ...p, enabled } : p)),
				});
			}
			return { prev };
		},
		onError: (_err, _vars, ctx) => {
			if (ctx?.prev) qc.setQueryData(qk.fleet(org), ctx.prev);
		},
		onSettled: () => qc.invalidateQueries({ queryKey: qk.fleet(org) }),
	});
}

/** Deletes a pool. Optimistically removes the card, reconciling on settle. */
export function useDeletePool() {
	const qc = useQueryClient();
	const { org } = useParams<{ org: string }>();
	return useMutation({
		mutationFn: (id: string) => deleteFleetPool(id),
		onMutate: async (id) => {
			await qc.cancelQueries({ queryKey: qk.fleet(org) });
			const prev = qc.getQueryData<FleetData>(qk.fleet(org));
			if (prev) {
				qc.setQueryData<FleetData>(qk.fleet(org), {
					...prev,
					pools: prev.pools.filter((p) => p.id !== id),
				});
			}
			return { prev };
		},
		onError: (_err, _id, ctx) => {
			if (ctx?.prev) qc.setQueryData(qk.fleet(org), ctx.prev);
		},
		onSettled: () => qc.invalidateQueries({ queryKey: qk.fleet(org) }),
	});
}
