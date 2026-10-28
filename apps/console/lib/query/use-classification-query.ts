// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Classification reads and the chip writes (#6129, ADR 0005 D1/D4). Every read is a
// `classification.*` GET procedure (lib/rpc/procedures/classification.ts); the settings route
// prefetches the taxonomy and the edit decision, so the manager paints with them. The chip writes go
// through `useActionMutation` with an optimistic patch. Live: a `classification` hint (a dimension,
// a value or an assignment changed — their triggers in programmables.sql) invalidates
// `orpc.classification.key()` (lib/query/topics.ts), so a chip another member pins shows here
// without a reload.

import { keepPreviousData, type QueryKey, useQuery, type UseQueryResult } from "@tanstack/react-query";
import {
	assignClassification,
	unassignClassification,
} from "@/app/server/actions/classification/assignments";
import type { DimensionDTO } from "@/app/server/actions/classification/dimensions";
import { useActionMutation } from "@/lib/actions/use-action-mutation";
import type { ResourceKind } from "@/lib/db/schema/enums";
import type { AssignedValue } from "@/lib/queries/classification";
import { orpc } from "@/lib/rpc/client";
import { retryUnlessRefused } from "@/lib/rpc/refusal";

/** Every classification read's key prefix — what a classification write invalidates. */
export function classificationReadKeys(): QueryKey[] {
	return [orpc.classification.key()];
}

/** The taxonomy read's input for a search: `{}` (the shared base every picker reuses) when blank. */
export function dimensionsInput(search?: string): { search?: string } {
	const q = search?.trim();
	return q ? { search: q } : {};
}

/**
 * The org's classification taxonomy (dimensions + values). Shared by the settings manager and
 * every picker. Pass `search` to filter server-side (the settings manager) — previous results are
 * kept while the next query loads so the list doesn't flash, and `isFetching` drives the in-flight
 * indicator. With no `search` the key is the shared base every picker reuses.
 */
export function useDimensionsQuery(search?: string): UseQueryResult<DimensionDTO[]> {
	return useQuery(
		orpc.classification.dimensions.queryOptions({
			input: dimensionsInput(search),
			placeholderData: keepPreviousData,
			retry: retryUnlessRefused,
		}),
	);
}

/**
 * Whether the caller holds `org:edit` — the server-side gate every assign/clear enforces.
 * The control ANDs this with a resource's own edit flag; one org-level key so N controls
 * dedupe to a single request.
 */
export function useCanEditClassification(): UseQueryResult<boolean> {
	return useQuery(orpc.classification.canEdit.queryOptions({ input: undefined, staleTime: 5 * 60_000 }));
}

/** The key of one resource's chips. */
function assignmentsKey(kind: ResourceKind, resourceId: string): QueryKey {
	return orpc.classification.assignments.queryKey({ input: { kind, resourceId } });
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
	return useQuery(
		orpc.classification.assignments.queryOptions({
			input: { kind, resourceId },
			initialData,
			// Mark seeded data fresh so a batch-hydrated list of N rows costs zero per-row
			// fetches (each row trusts its slice until the staleTime elapses).
			initialDataUpdatedAt: initialData ? Date.now() : undefined,
		}),
	);
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
	return useQuery(
		orpc.classification.assignmentsForKind.queryOptions({
			input: { kind, resourceIds },
			enabled: resourceIds.length > 0,
		}),
	);
}

/**
 * Assign/clear mutations for a resource's chips, through the mutation contract: the chip
 * appears/disappears immediately (an optimistic patch, rolled back on a refusal), the call is
 * pending while in flight (bind it to the controls' `disabled`), and every classification read is
 * invalidated when it settles — this resource's chips, the batched list hydration, the taxonomy's
 * usage counts and the breakdowns. Single-valued swaps are resolved server-side; the refetch
 * reconciles the exact server state.
 */
export function useAssignmentMutations(kind: ResourceKind, resourceId: string, dimensions: DimensionDTO[]) {
	const key = assignmentsKey(kind, resourceId);

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
					enforcement: v.enforcement,
				};
			}
		}
		return null;
	}

	/** The chips currently cached for this resource (none when the cache holds something else). */
	function chipsOf(current: unknown): AssignedValue[] {
		if (!Array.isArray(current)) return [];
		return current.filter(isAssignedValue);
	}

	const assign = useActionMutation(
		(valueId: string) =>
			assignClassification({ value_id: valueId, resource_kind: kind, resource_id: resourceId }),
		{
			invalidates: classificationReadKeys(),
			optimistic: [
				{
					key,
					update: (current, valueId) => {
						const prev = chipsOf(current);
						const chip = chipFor(valueId);
						if (!chip) return prev;
						// Single-valued dimensions replace their existing chip; multi appends.
						return chip.multi
							? [...prev, chip]
							: [...prev.filter((c) => c.dimension_id !== chip.dimension_id), chip];
					},
				},
			],
		},
	);

	const unassign = useActionMutation(
		(valueId: string) =>
			unassignClassification({ value_id: valueId, resource_kind: kind, resource_id: resourceId }),
		{
			invalidates: classificationReadKeys(),
			optimistic: [
				{
					key,
					update: (current, valueId) => chipsOf(current).filter((c) => c.value_id !== valueId),
				},
			],
		},
	);

	return { assign, unassign };
}

/** Narrows a cached value to a chip: the fields the optimistic patches read and write. */
function isAssignedValue(value: unknown): value is AssignedValue {
	return (
		typeof value === "object" &&
		value !== null &&
		"value_id" in value &&
		typeof value.value_id === "string" &&
		"dimension_id" in value &&
		typeof value.dimension_id === "string"
	);
}
