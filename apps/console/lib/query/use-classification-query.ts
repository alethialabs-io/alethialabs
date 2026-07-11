// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import {
	keepPreviousData,
	useMutation,
	useQuery,
	useQueryClient,
	type UseQueryResult,
} from "@tanstack/react-query";
import type { DimensionDTO } from "@/app/server/actions/classification/dimensions";
import { listDimensions } from "@/app/server/actions/classification/dimensions";
import {
	assignClassification,
	canEditClassification,
	getAssignments,
	getAssignmentsForKind,
	unassignClassification,
} from "@/app/server/actions/classification/assignments";
import type { ResourceKind } from "@/lib/db/schema/enums";
import type { AssignedValue } from "@/lib/queries/classification";
import { qk } from "./keys";

/**
 * The org's classification taxonomy (dimensions + values). Shared by the settings manager
 * and every picker; org-scoped server-side so the key isn't org-slugged. Pass `search` to
 * filter server-side (the settings manager) — previous results are kept while the next query
 * loads so the list doesn't flash, and `isFetching` drives the in-flight indicator. With no
 * `search` the key is the shared base every picker reuses.
 */
export function useDimensionsQuery(
	search?: string,
): UseQueryResult<DimensionDTO[]> {
	const q = search?.trim() || undefined;
	return useQuery({
		queryKey: qk.classificationDimensions(q),
		queryFn: () => listDimensions(q),
		placeholderData: keepPreviousData,
	});
}

/**
 * Whether the caller holds `org:edit` — the server-side gate every assign/clear enforces.
 * The control ANDs this with a resource's own edit flag; one org-level key so N controls
 * dedupe to a single request.
 */
export function useCanEditClassification(): UseQueryResult<boolean> {
	return useQuery({
		queryKey: qk.classificationCanEdit(),
		queryFn: () => canEditClassification(),
		staleTime: 5 * 60_000,
	});
}

/**
 * The classification chips assigned to a single resource. Pass `initialData` (e.g. a row
 * from a batched `assignmentsForKind` hydration) to seed the cache so the first paint is
 * instant and the query still stays reactive to picker mutations.
 */
export function useAssignmentsQuery(
	kind: ResourceKind,
	resourceId: string,
	initialData?: AssignedValue[],
): UseQueryResult<AssignedValue[]> {
	return useQuery({
		queryKey: qk.classificationAssignments(kind, resourceId),
		queryFn: () => getAssignments(kind, resourceId),
		initialData,
		// Mark seeded data fresh so a batch-hydrated list of N rows costs zero per-row
		// fetches (each row trusts its slice until the 30s staleTime elapses).
		initialDataUpdatedAt: initialData ? Date.now() : undefined,
	});
}

/**
 * One-query batched hydration for a client list: the chips for every `resourceIds` entry of
 * one kind. Callers pass `map[id]` into each row's `initialAssignments` so per-row chips +
 * pickers read seeded-fresh data (zero per-row fetches). Empty ids short-circuit.
 */
export function useAssignmentsForKind(
	kind: ResourceKind,
	resourceIds: string[],
): UseQueryResult<Record<string, AssignedValue[]>> {
	return useQuery({
		queryKey: qk.classificationAssignmentsForKind(kind, resourceIds),
		queryFn: () => getAssignmentsForKind(kind, resourceIds),
		enabled: resourceIds.length > 0,
	});
}

/**
 * Assign/clear mutations for a resource's chips, with optimistic cache updates: the chip
 * appears/disappears immediately and rolls back on error. Single-valued swaps are resolved
 * server-side, so we refetch on settle to reconcile the exact server state.
 */
export function useAssignmentMutations(
	kind: ResourceKind,
	resourceId: string,
	dimensions: DimensionDTO[],
) {
	const qc = useQueryClient();
	const key = qk.classificationAssignments(kind, resourceId);

	/** Builds the AssignedValue chip for a value id from the loaded taxonomy. */
	function chipFor(valueId: string): AssignedValue | null {
		for (const d of dimensions) {
			const v = d.values.find((x) => x.id === valueId);
			if (v) {
				return {
					assignment_id: `optimistic-${valueId}`,
					dimension_id: d.id,
					dimension_key: d.key,
					dimension_label: d.label,
					multi: d.multi,
					value_id: v.id,
					value: v.value,
					value_label: v.label,
					color: v.color,
				};
			}
		}
		return null;
	}

	const assign = useMutation({
		mutationFn: (valueId: string) =>
			assignClassification({
				value_id: valueId,
				resource_kind: kind,
				resource_id: resourceId,
			}),
		onMutate: async (valueId: string) => {
			await qc.cancelQueries({ queryKey: key });
			const prev = qc.getQueryData<AssignedValue[]>(key) ?? [];
			const chip = chipFor(valueId);
			if (chip) {
				// Single-valued dimensions replace their existing chip; multi appends.
				const next = chip.multi
					? [...prev, chip]
					: [...prev.filter((c) => c.dimension_id !== chip.dimension_id), chip];
				qc.setQueryData<AssignedValue[]>(key, next);
			}
			return { prev };
		},
		onError: (_e, _v, ctx) => {
			if (ctx?.prev) qc.setQueryData(key, ctx.prev);
		},
		onSettled: () => qc.invalidateQueries({ queryKey: key }),
	});

	const unassign = useMutation({
		mutationFn: (valueId: string) =>
			unassignClassification({
				value_id: valueId,
				resource_kind: kind,
				resource_id: resourceId,
			}),
		onMutate: async (valueId: string) => {
			await qc.cancelQueries({ queryKey: key });
			const prev = qc.getQueryData<AssignedValue[]>(key) ?? [];
			qc.setQueryData<AssignedValue[]>(
				key,
				prev.filter((c) => c.value_id !== valueId),
			);
			return { prev };
		},
		onError: (_e, _v, ctx) => {
			if (ctx?.prev) qc.setQueryData(key, ctx.prev);
		},
		onSettled: () => qc.invalidateQueries({ queryKey: key }),
	});

	return { assign, unassign };
}
