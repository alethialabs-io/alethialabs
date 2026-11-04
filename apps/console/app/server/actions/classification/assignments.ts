"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Server actions for pinning classification values to resources (ADR 0005 D4, #6129): `defineAction`s
// returning `ActionResult<T>`. Reading a resource's chips (`classification.assignments` and
// `.assignmentsForKind`, lib/rpc/procedures/classification.ts) gates on `org:view`; assigning/clearing
// on `org:edit`. Single-valued dimensions replace any
// prior value transactionally (a partial unique index can't reference the parent's `multi`),
// while the DB's (kind, id, value) unique blocks exact duplicates. All via withScope (RLS wall).
// A resource that lives in a project (the project, its environments, its clusters) also asks the
// same action about that project (lib/classification/resource-project.ts): its chips are read only
// by a member who may view the project, and changed only by one who may edit it.

import { and, eq } from "drizzle-orm";
import { defineAction } from "@/lib/actions/define-action";
import { ActionRefusal, type ActionResult } from "@/lib/actions/result";
import { authorize } from "@/lib/authz/guard";
import { classifiableResourceInOrg } from "@/lib/classification/resource-org";
import { mayClassifyResource } from "@/lib/classification/resource-project";
import { withScope } from "@/lib/db";
import {
	classificationAssignment,
	classificationDimension,
	classificationValue,
} from "@/lib/db/schema";
import type { ResourceKind } from "@/lib/db/schema/enums";
import {
	type AssignInput,
	assignInputSchema,
	type UnassignInput,
	unassignInputSchema,
} from "@/lib/validations/classification";

/** One resource-kind's share of the resources carrying a value (drill-down breakdown). */
export interface ValueKindCount {
	resource_kind: ResourceKind;
	count: number;
}

/**
 * Pins a value to a resource. The value's owning dimension is resolved server-side; for a
 * single-valued dimension any existing assignment of that dimension on the resource is
 * cleared first (a value swap), so a resource holds at most one value per single dimension.
 * Idempotent — re-assigning the same value is a no-op. A resource that is not this org's, or that
 * lives in a project the caller may not edit, is a `not-found` refusal (the latter recorded).
 */
export async function assignClassification(raw: AssignInput): Promise<ActionResult<{ assigned: true }>> {
	return defineAction({
		input: assignInputSchema,
		run: async ({ input }) => {
			await writeAssignment(input);
			return { assigned: true as const };
		},
	})(raw);
}

/** The body of {@link assignClassification}, on input whose SHAPE is already checked. */
async function writeAssignment(data: AssignInput): Promise<void> {
	const actor = await authorize("edit", { type: "org" });
	// The resource must be this organization's: the assignment's RLS wall is its dimension's org,
	// and the resource id is a bare uuid, so nothing else ties the two together. One that lives in a
	// project the caller may not edit is answered the same way (the refusal is recorded).
	if (
		!(await classifiableResourceInOrg(data.resource_kind, data.resource_id, actor)) ||
		!(await mayClassifyResource(actor, data.resource_kind, data.resource_id, "edit"))
	)
		throw new ActionRefusal("not-found", "Resource not found");

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
		if (!value) throw new ActionRefusal("not-found", "Value not found");

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

/**
 * Clears a single value assignment from a resource. A resource that lives in a project the caller
 * may not edit is answered as an unknown resource is — nothing is cleared, nothing is refused —
 * and the refusal is recorded.
 */
export async function unassignClassification(raw: UnassignInput): Promise<ActionResult<null>> {
	return defineAction({
		input: unassignInputSchema,
		run: async ({ input }) => {
			const actor = await authorize("edit", { type: "org" });
			if (!(await mayClassifyResource(actor, input.resource_kind, input.resource_id, "edit"))) return null;
			await withScope({ ownerId: actor.userId, orgId: actor.orgId }, (tx) =>
				tx
					.delete(classificationAssignment)
					.where(
						and(
							eq(classificationAssignment.resource_kind, input.resource_kind),
							eq(classificationAssignment.resource_id, input.resource_id),
							eq(classificationAssignment.value_id, input.value_id),
						),
					),
			);
			return null;
		},
	})(raw);
}
