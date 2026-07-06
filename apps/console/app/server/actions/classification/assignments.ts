"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Server actions for pinning classification values to resources. Reading a resource's chips
// gates on `org:view`; assigning/clearing on `org:edit`. Single-valued dimensions replace any
// prior value transactionally (a partial unique index can't reference the parent's `multi`),
// while the DB's (kind, id, value) unique blocks exact duplicates. All via withScope (RLS wall).

import { and, eq } from "drizzle-orm";
import { authorize } from "@/lib/authz/guard";
import { withScope } from "@/lib/db";
import {
	classificationAssignment,
	classificationDimension,
	classificationValue,
} from "@/lib/db/schema";
import type { ResourceKind } from "@/lib/db/schema/enums";
import {
	type AssignedValue,
	listAssignmentsFor,
} from "@/lib/queries/classification";
import {
	type AssignInput,
	assignInputSchema,
	type UnassignInput,
	unassignInputSchema,
} from "@/lib/validations/classification";

/** Lists the classification chips assigned to a single resource. */
export async function getAssignments(
	kind: ResourceKind,
	resourceId: string,
): Promise<AssignedValue[]> {
	const actor = await authorize("view", { type: "org" });
	return withScope({ ownerId: actor.userId, orgId: actor.orgId }, (tx) =>
		listAssignmentsFor(tx, kind, resourceId),
	);
}

/**
 * Pins a value to a resource. The value's owning dimension is resolved server-side; for a
 * single-valued dimension any existing assignment of that dimension on the resource is
 * cleared first (a value swap), so a resource holds at most one value per single dimension.
 * Idempotent — re-assigning the same value is a no-op.
 */
export async function assignClassification(input: AssignInput): Promise<void> {
	const actor = await authorize("edit", { type: "org" });
	const data = assignInputSchema.parse(input);

	await withScope({ ownerId: actor.userId, orgId: actor.orgId }, async (tx) => {
		// Resolve the value → its dimension (+ multi flag) in one join; RLS scopes this
		// to the org (join through the dimension the child value belongs to).
		const [value] = await tx
			.select({
				id: classificationValue.id,
				dimension_id: classificationValue.dimension_id,
				multi: classificationDimension.multi,
			})
			.from(classificationValue)
			.innerJoin(
				classificationDimension,
				eq(classificationDimension.id, classificationValue.dimension_id),
			)
			.where(eq(classificationValue.id, data.value_id))
			.limit(1);
		if (!value) throw new Error("Value not found");

		// Single-valued: clear any prior value of this dimension on the resource first.
		if (!value.multi) {
			await tx
				.delete(classificationAssignment)
				.where(
					and(
						eq(classificationAssignment.resource_kind, data.resource_kind),
						eq(classificationAssignment.resource_id, data.resource_id),
						eq(classificationAssignment.dimension_id, value.dimension_id),
					),
				);
		}

		await tx
			.insert(classificationAssignment)
			.values({
				org_id: actor.orgId,
				dimension_id: value.dimension_id,
				value_id: value.id,
				resource_kind: data.resource_kind,
				resource_id: data.resource_id,
				assigned_by: actor.userId,
			})
			.onConflictDoNothing({
				target: [
					classificationAssignment.resource_kind,
					classificationAssignment.resource_id,
					classificationAssignment.value_id,
				],
			});
	});
}

/** Clears a single value assignment from a resource. */
export async function unassignClassification(
	input: UnassignInput,
): Promise<void> {
	const actor = await authorize("edit", { type: "org" });
	const data = unassignInputSchema.parse(input);
	await withScope({ ownerId: actor.userId, orgId: actor.orgId }, (tx) =>
		tx
			.delete(classificationAssignment)
			.where(
				and(
					eq(classificationAssignment.resource_kind, data.resource_kind),
					eq(classificationAssignment.resource_id, data.resource_id),
					eq(classificationAssignment.value_id, data.value_id),
				),
			),
	);
}
