// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Typed query builders for structured classification. All take the scoped transaction from
// withScope/withOwnerScope (RLS is the tenancy wall — org-scoped dimensions + parent-scoped
// values/assignments); these are the shaping/hydration helpers on top.

import { and, asc, eq, inArray } from "drizzle-orm";
import type { getServiceDb } from "@/lib/db";
import {
	type ClassificationDimension,
	type ClassificationValue,
	classificationAssignment,
	classificationDimension,
	classificationValue,
} from "@/lib/db/schema";
import type { ResourceKind } from "@/lib/db/schema/enums";

type Db = ReturnType<typeof getServiceDb>;
/** The scoped transaction handed to a withScope/withOwnerScope callback. */
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** A dimension with its allowed values, ordered for display. */
export interface DimensionWithValues extends ClassificationDimension {
	values: ClassificationValue[];
}

/** A single assigned chip (value + its owning dimension), denormalized for read views. */
export interface AssignedValue {
	assignment_id: string;
	dimension_id: string;
	dimension_key: string;
	dimension_label: string;
	multi: boolean;
	value_id: string;
	value: string;
	value_label: string;
	color: string | null;
}

/**
 * Lists every dimension in scope with its allowed values nested, both ordered by
 * (position, created_at) so the settings UI and the picker render deterministically.
 */
export async function listDimensionsWithValues(
	tx: Tx,
): Promise<DimensionWithValues[]> {
	const dims = await tx
		.select()
		.from(classificationDimension)
		.orderBy(
			asc(classificationDimension.position),
			asc(classificationDimension.created_at),
		);
	if (dims.length === 0) return [];

	const values = await tx
		.select()
		.from(classificationValue)
		.where(
			inArray(
				classificationValue.dimension_id,
				dims.map((d) => d.id),
			),
		)
		.orderBy(
			asc(classificationValue.position),
			asc(classificationValue.created_at),
		);

	const byDim = new Map<string, ClassificationValue[]>();
	for (const v of values) {
		const list = byDim.get(v.dimension_id) ?? [];
		list.push(v);
		byDim.set(v.dimension_id, list);
	}
	return dims.map((d) => ({ ...d, values: byDim.get(d.id) ?? [] }));
}

/** The select projection shared by the two assignment-hydration helpers. */
const assignedValueColumns = {
	assignment_id: classificationAssignment.id,
	dimension_id: classificationDimension.id,
	dimension_key: classificationDimension.key,
	dimension_label: classificationDimension.label,
	multi: classificationDimension.multi,
	value_id: classificationValue.id,
	value: classificationValue.value,
	value_label: classificationValue.label,
	color: classificationValue.color,
} as const;

/**
 * Loads the assigned values (chips) for ONE resource, joined to their dimension + value,
 * ordered by dimension then value position for a stable chip row.
 */
export async function listAssignmentsFor(
	tx: Tx,
	kind: ResourceKind,
	resourceId: string,
): Promise<AssignedValue[]> {
	return tx
		.select(assignedValueColumns)
		.from(classificationAssignment)
		.innerJoin(
			classificationValue,
			eq(classificationValue.id, classificationAssignment.value_id),
		)
		.innerJoin(
			classificationDimension,
			eq(classificationDimension.id, classificationAssignment.dimension_id),
		)
		.where(
			and(
				eq(classificationAssignment.resource_kind, kind),
				eq(classificationAssignment.resource_id, resourceId),
			),
		)
		.orderBy(
			asc(classificationDimension.position),
			asc(classificationValue.position),
		);
}

/**
 * Batched hydration for list views: loads assignments for MANY resources of the same kind
 * in one round-trip, returned as a map keyed by resource_id (empty entries omitted).
 */
export async function assignmentsForKind(
	tx: Tx,
	kind: ResourceKind,
	resourceIds: string[],
): Promise<Map<string, AssignedValue[]>> {
	const out = new Map<string, AssignedValue[]>();
	if (resourceIds.length === 0) return out;

	const rows = await tx
		.select({
			...assignedValueColumns,
			resource_id: classificationAssignment.resource_id,
		})
		.from(classificationAssignment)
		.innerJoin(
			classificationValue,
			eq(classificationValue.id, classificationAssignment.value_id),
		)
		.innerJoin(
			classificationDimension,
			eq(classificationDimension.id, classificationAssignment.dimension_id),
		)
		.where(
			and(
				eq(classificationAssignment.resource_kind, kind),
				inArray(classificationAssignment.resource_id, resourceIds),
			),
		)
		.orderBy(
			asc(classificationDimension.position),
			asc(classificationValue.position),
		);

	for (const row of rows) {
		const { resource_id, ...rest } = row;
		const list = out.get(resource_id) ?? [];
		list.push(rest);
		out.set(resource_id, list);
	}
	return out;
}

/** The resource references (kind + id) currently carrying a given value. */
export async function listResourceIdsByValue(
	tx: Tx,
	valueId: string,
): Promise<{ resource_kind: ResourceKind; resource_id: string }[]> {
	return tx
		.select({
			resource_kind: classificationAssignment.resource_kind,
			resource_id: classificationAssignment.resource_id,
		})
		.from(classificationAssignment)
		.where(eq(classificationAssignment.value_id, valueId));
}
