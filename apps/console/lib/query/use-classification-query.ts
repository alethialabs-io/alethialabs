// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import {
	useMutation,
	useQuery,
	useQueryClient,
	type UseQueryResult,
} from "@tanstack/react-query";
import type { DimensionDTO } from "@/app/server/actions/classification/dimensions";
import { listDimensions } from "@/app/server/actions/classification/dimensions";
import {
	assignClassification,
	getAssignments,
	unassignClassification,
} from "@/app/server/actions/classification/assignments";
import type { ResourceKind } from "@/lib/db/schema/enums";
import type { AssignedValue } from "@/lib/queries/classification";
import { qk } from "./keys";

/**
 * The org's classification taxonomy (dimensions + values). Shared by the settings manager
 * and every picker; org-scoped server-side so the key isn't org-slugged.
 */
export function useDimensionsQuery(): UseQueryResult<DimensionDTO[]> {
	return useQuery({
		queryKey: qk.classificationDimensions(),
		queryFn: () => listDimensions(),
	});
}

/** The classification chips assigned to a single resource. */
export function useAssignmentsQuery(
	kind: ResourceKind,
	resourceId: string,
	enabled = true,
): UseQueryResult<AssignedValue[]> {
	return useQuery({
		queryKey: qk.classificationAssignments(kind, resourceId),
		queryFn: () => getAssignments(kind, resourceId),
		enabled,
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
