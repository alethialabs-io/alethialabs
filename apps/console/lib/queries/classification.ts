// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Typed query builders for structured classification. All take the scoped transaction from
// withScope/withOwnerScope (RLS is the tenancy wall — org-scoped dimensions + parent-scoped
// values/assignments); these are the shaping/hydration helpers on top.

import {
	and,
	asc,
	count,
	eq,
	exists,
	ilike,
	inArray,
	isNotNull,
	or,
	sql,
} from "drizzle-orm";
import type { getServiceDb } from "@/lib/db";
import {
	type ClassificationDimension,
	type ClassificationValue,
	classificationAssignment,
	classificationDimension,
	classificationValue,
} from "@/lib/db/schema";
import type { ResourceKind } from "@/lib/db/schema/enums";
import type { EnforcingValue } from "@/lib/promotions/gates";
import type { ClassificationEnforcement } from "@/types/jsonb.types";

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
	/** Promotion-gate policy this value imposes (drives inherited gate chips); null ⇒ inert. */
	enforcement: ClassificationEnforcement | null;
}

/**
 * Lists every dimension in scope with its allowed values nested, both ordered by
 * (position, created_at) so the settings UI and the picker render deterministically. When
 * `search` is given, filters (in SQL) to dimensions whose label/key matches OR that own a
 * matching value — a matched dimension still returns all of its values.
 */
export async function listDimensionsWithValues(
	tx: Tx,
	search?: string,
): Promise<DimensionWithValues[]> {
	const q = search?.trim();
	const like = q ? `%${q}%` : null;
	const where = like
		? or(
				ilike(classificationDimension.label, like),
				ilike(classificationDimension.key, like),
				exists(
					tx
						.select({ one: sql`1` })
						.from(classificationValue)
						.where(
							and(
								eq(
									classificationValue.dimension_id,
									classificationDimension.id,
								),
								or(
									ilike(classificationValue.label, like),
									ilike(classificationValue.value, like),
								),
							),
						),
				),
			)
		: undefined;

	const dims = await tx
		.select()
		.from(classificationDimension)
		.where(where)
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
	enforcement: classificationValue.enforcement,
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

// ── Usage / coverage counts (powers the settings coverage view) ──────────────────────

/**
 * Assignment count per value across the org scope — i.e. how many resources carry each
 * value. The (kind, id, value) unique means one assignment == one distinct resource, so a
 * plain COUNT(*) is the distinct-resource count. Values with no assignments are absent from
 * the map (→ treat as 0 / "unused").
 */
export async function countAssignmentsByValue(
	tx: Tx,
): Promise<Map<string, number>> {
	const rows = await tx
		.select({ value_id: classificationAssignment.value_id, n: count() })
		.from(classificationAssignment)
		.groupBy(classificationAssignment.value_id);
	const out = new Map<string, number>();
	for (const r of rows) out.set(r.value_id, Number(r.n));
	return out;
}

/**
 * Distinct resources carrying ANY value of each dimension (its coverage). A `multi`
 * dimension can pin two values to one resource, so this counts distinct (kind, id) pairs —
 * NOT the sum of the per-value counts. Dimensions with no assignments are absent (→ 0).
 */
export async function countResourcesByDimension(
	tx: Tx,
): Promise<Map<string, number>> {
	const rows = await tx
		.select({
			dimension_id: classificationAssignment.dimension_id,
			n: sql<number>`count(distinct (${classificationAssignment.resource_kind}, ${classificationAssignment.resource_id}))`,
		})
		.from(classificationAssignment)
		.groupBy(classificationAssignment.dimension_id);
	const out = new Map<string, number>();
	for (const r of rows) out.set(r.dimension_id, Number(r.n));
	return out;
}

/**
 * Per-resource-kind breakdown of the resources carrying a given value — the drill-down
 * behind "24 resources: 12 projects · 8 clusters · 4 runners". Ordered by kind for a stable
 * list.
 */
export async function countAssignmentsByKindForValue(
	tx: Tx,
	valueId: string,
): Promise<{ resource_kind: ResourceKind; count: number }[]> {
	const rows = await tx
		.select({
			resource_kind: classificationAssignment.resource_kind,
			n: count(),
		})
		.from(classificationAssignment)
		.where(eq(classificationAssignment.value_id, valueId))
		.groupBy(classificationAssignment.resource_kind)
		.orderBy(asc(classificationAssignment.resource_kind));
	return rows.map((r) => ({
		resource_kind: r.resource_kind,
		count: Number(r.n),
	}));
}

/**
 * The assigned values on a resource that carry a non-null `enforcement` policy — the classification
 * values that impose promotion gates on the resource (label drives policy). Feeds
 * `applyClassificationEnforcement` in the gate engine. Non-enforcing values are filtered out in SQL.
 */
export async function getEnforcingValuesFor(
	tx: Db | Tx,
	kind: ResourceKind,
	resourceId: string,
): Promise<EnforcingValue[]> {
	const rows = await tx
		.select({
			value_label: classificationValue.label,
			dimension_label: classificationDimension.label,
			enforcement: classificationValue.enforcement,
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
				eq(classificationAssignment.resource_id, resourceId),
				isNotNull(classificationValue.enforcement),
			),
		);
	// The isNotNull filter guarantees non-null; narrow for the type.
	return rows.flatMap((r) =>
		r.enforcement
			? [
					{
						value_label: r.value_label,
						dimension_label: r.dimension_label,
						enforcement: r.enforcement,
					},
				]
			: [],
	);
}

/**
 * Distinct resources per kind carrying ANY value of a dimension — the "coverage by resource
 * kind" panel for the selected dimension. Counts distinct resource_id per kind (a multi
 * dimension can pin two values to one resource, so plain COUNT would double-count).
 */
export async function countResourcesByKindForDimension(
	tx: Tx,
	dimensionId: string,
): Promise<{ resource_kind: ResourceKind; count: number }[]> {
	const rows = await tx
		.select({
			resource_kind: classificationAssignment.resource_kind,
			n: sql<number>`count(distinct ${classificationAssignment.resource_id})`,
		})
		.from(classificationAssignment)
		.where(eq(classificationAssignment.dimension_id, dimensionId))
		.groupBy(classificationAssignment.resource_kind)
		.orderBy(asc(classificationAssignment.resource_kind));
	return rows.map((r) => ({
		resource_kind: r.resource_kind,
		count: Number(r.n),
	}));
}
