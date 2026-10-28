"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Server actions for the classification taxonomy — CRUD over dimensions (named axes) and their
// allowed values (ADR 0005 D4, #6129): `defineAction`s returning `ActionResult<T>`. The taxonomy READ
// moved to `lib/rpc/procedures/classification.ts` (`classification.dimensions`, over GET). Mutations
// gate on `org:edit` (classification is org-wide taxonomy; a dedicated PDP resource is a follow-up).
// Every query runs inside withScope so RLS (org-scoped dimensions, parent-scoped values) is the
// tenancy wall: an id of another org's dimension or value matches no row, and is answered as an
// unknown id is.

import { eq } from "drizzle-orm";
import { z } from "zod";
import { defineAction } from "@/lib/actions/define-action";
import { ActionRefusal, type ActionResult, FieldRefusal } from "@/lib/actions/result";
import { authorize } from "@/lib/authz/guard";
import { withScope } from "@/lib/db";
import { classificationDimension, classificationValue } from "@/lib/db/schema";
import type { ResourceKind } from "@/lib/db/schema/enums";
import type { ClassificationEnforcement } from "@/types/jsonb.types";
import { dimensionInputSchema, valueInputSchema } from "@/lib/validations/classification";

/** Client-safe value DTO (no org_id). `assignmentCount` = resources carrying this value. */
export interface ValueDTO {
	id: string;
	dimension_id: string;
	value: string;
	label: string;
	color: string | null;
	/** Promotion-gate policy this value imposes on envs carrying it; null ⇒ inert. */
	enforcement: ClassificationEnforcement | null;
	position: number;
	/** How many resources currently carry this value (0 → unused). */
	assignmentCount: number;
}

/** Client-safe dimension DTO with its values nested. `resourceCount` = distinct resources
 * carrying any value of this axis (its coverage). */
export interface DimensionDTO {
	id: string;
	key: string;
	label: string;
	description: string | null;
	multi: boolean;
	position: number;
	/** Resource kinds this dimension applies to; empty ⇒ all kinds. */
	appliesTo: ResourceKind[];
	/** Distinct resources carrying any value of this dimension (0 → unused axis). */
	resourceCount: number;
	values: ValueDTO[];
}

/**
 * Whether a driver error is the unique violation of `constraint` (`23505`). postgres-js surfaces
 * `constraint_name`; a wrapper may keep only the text, so the message is read too.
 */
function violates(err: unknown, constraint: string): boolean {
	let link: unknown = err;
	for (let depth = 0; depth < 5 && typeof link === "object" && link !== null; depth++) {
		const code = "code" in link ? link.code : undefined;
		const name = "constraint_name" in link ? link.constraint_name : undefined;
		const message = "message" in link && typeof link.message === "string" ? link.message : "";
		if (code === "23505" && (name === constraint || message.includes(constraint))) return true;
		link = "cause" in link ? link.cause : undefined;
	}
	return false;
}

/** Runs a write, turning the taxonomy's two unique violations into refusals under their fields. */
async function withUniqueFields<T>(write: () => Promise<T>): Promise<T> {
	try {
		return await write();
	} catch (err) {
		if (violates(err, "classification_dimension_org_key")) {
			throw new FieldRefusal({ key: ["Another dimension already uses this key."] }, "That key is taken.");
		}
		if (violates(err, "classification_value_dimension_value")) {
			throw new FieldRefusal({ value: ["This dimension already has a value with this slug."] }, "That value is taken.");
		}
		throw err;
	}
}

/** A row addressed by id. */
const idInput = z.object({ id: z.string().uuid() });

/** An ordered list of row ids (a drag-reorder). */
const orderInput = z.object({ ids: z.array(z.string().uuid()).max(500) });

/** Creates a dimension (an axis). Returns its new id. */
export async function createDimension(raw: z.input<typeof dimensionInputSchema>): Promise<ActionResult<{ id: string }>> {
	return defineAction({
		input: dimensionInputSchema,
		run: async ({ input: data }) => {
			const actor = await authorize("edit", { type: "org" });
			const id = await withUniqueFields(() =>
				withScope({ ownerId: actor.userId, orgId: actor.orgId }, async (tx) => {
					const [row] = await tx
						.insert(classificationDimension)
						.values({
							org_id: actor.orgId,
							created_by: actor.userId,
							key: data.key,
							label: data.label,
							description: data.description ?? null,
							multi: data.multi ?? false,
							applies_to: data.applies_to ?? [],
							position: data.position ?? 0,
						})
						.returning({ id: classificationDimension.id });
					return row.id;
				}),
			);
			return { id };
		},
	})(raw);
}

/** An edit of a dimension: its id and its new presentation, mode and resource-kind scope. */
const updateDimensionInput = dimensionInputSchema.extend({ id: z.string().uuid() });

/** Updates a dimension's presentation, single/multi mode, and resource-kind scope. */
export async function updateDimension(
	raw: z.input<typeof updateDimensionInput>,
): Promise<ActionResult<{ updated: true }>> {
	return defineAction({
		input: updateDimensionInput,
		run: async ({ input: data }) => {
			const actor = await authorize("edit", { type: "org" });
			const rows = await withUniqueFields(() =>
				withScope({ ownerId: actor.userId, orgId: actor.orgId }, (tx) =>
					tx
						.update(classificationDimension)
						.set({
							key: data.key,
							label: data.label,
							description: data.description ?? null,
							multi: data.multi ?? false,
							applies_to: data.applies_to ?? [],
							position: data.position ?? 0,
						})
						.where(eq(classificationDimension.id, data.id))
						.returning({ id: classificationDimension.id }),
				),
			);
			if (rows.length === 0) throw new ActionRefusal("not-found", "That dimension no longer exists.");
			return { updated: true as const };
		},
	})(raw);
}

/** Deletes a dimension; its values + assignments cascade (FK ON DELETE cascade). */
export async function deleteDimension(raw: z.input<typeof idInput>): Promise<ActionResult<{ deleted: true }>> {
	return defineAction({
		input: idInput,
		run: async ({ input }) => {
			const actor = await authorize("edit", { type: "org" });
			await withScope({ ownerId: actor.userId, orgId: actor.orgId }, (tx) =>
				tx.delete(classificationDimension).where(eq(classificationDimension.id, input.id)),
			);
			return { deleted: true as const };
		},
	})(raw);
}

/** A new value on a dimension. */
const createValueInput = valueInputSchema.extend({ dimensionId: z.string().uuid() });

/** Adds an allowed value to a dimension. Returns its new id. */
export async function createValue(raw: z.input<typeof createValueInput>): Promise<ActionResult<{ id: string }>> {
	return defineAction({
		input: createValueInput,
		run: async ({ input: data }) => {
			const actor = await authorize("edit", { type: "org" });
			const id = await withUniqueFields(() =>
				withScope({ ownerId: actor.userId, orgId: actor.orgId }, async (tx) => {
					// Confirm the dimension is in scope (RLS already blocks cross-org) before
					// stamping the child row's denormalized org_id.
					const [dim] = await tx
						.select({ id: classificationDimension.id })
						.from(classificationDimension)
						.where(eq(classificationDimension.id, data.dimensionId))
						.limit(1);
					if (!dim) throw new ActionRefusal("not-found", "That dimension no longer exists.");
					const [row] = await tx
						.insert(classificationValue)
						.values({
							org_id: actor.orgId,
							dimension_id: data.dimensionId,
							value: data.value,
							label: data.label,
							color: data.color ?? null,
							enforcement: data.enforcement ?? null,
							position: data.position ?? 0,
						})
						.returning({ id: classificationValue.id });
					return row.id;
				}),
			);
			return { id };
		},
	})(raw);
}

/** An edit of a value: its id and its new presentation. */
const updateValueInput = valueInputSchema.extend({ id: z.string().uuid() });

/** Updates a value's presentation. */
export async function updateValue(raw: z.input<typeof updateValueInput>): Promise<ActionResult<{ updated: true }>> {
	return defineAction({
		input: updateValueInput,
		run: async ({ input: data }) => {
			const actor = await authorize("edit", { type: "org" });
			const rows = await withUniqueFields(() =>
				withScope({ ownerId: actor.userId, orgId: actor.orgId }, (tx) =>
					tx
						.update(classificationValue)
						.set({
							value: data.value,
							label: data.label,
							color: data.color ?? null,
							enforcement: data.enforcement ?? null,
							position: data.position ?? 0,
						})
						.where(eq(classificationValue.id, data.id))
						.returning({ id: classificationValue.id }),
				),
			);
			if (rows.length === 0) throw new ActionRefusal("not-found", "That value no longer exists.");
			return { updated: true as const };
		},
	})(raw);
}

/** Deletes a value; its assignments cascade. */
export async function deleteValue(raw: z.input<typeof idInput>): Promise<ActionResult<{ deleted: true }>> {
	return defineAction({
		input: idInput,
		run: async ({ input }) => {
			const actor = await authorize("edit", { type: "org" });
			await withScope({ ownerId: actor.userId, orgId: actor.orgId }, (tx) =>
				tx.delete(classificationValue).where(eq(classificationValue.id, input.id)),
			);
			return { deleted: true as const };
		},
	})(raw);
}

/** One value in a template / bulk create (presentation only; server stamps the rest). */
export interface SeedValue {
	value: string;
	label: string;
	color?: string | null;
}

/** A dimension and its initial values, created together. */
const createWithValuesInput = z.object({
	dimension: dimensionInputSchema,
	// A template's colour may be null (no accent), which the form's optional colour does not take.
	values: z
		.array(
			valueInputSchema
				.pick({ value: true, label: true })
				.extend({ color: valueInputSchema.shape.color.nullable() }),
		)
		.max(100),
});

/**
 * Creates a dimension together with its initial values in one transaction — powers the
 * empty-state starter templates (and any bulk author). Returns the new dimension id.
 */
export async function createDimensionWithValues(
	raw: z.input<typeof createWithValuesInput>,
): Promise<ActionResult<{ id: string }>> {
	return defineAction({
		input: createWithValuesInput,
		run: async ({ input }) => {
			const actor = await authorize("edit", { type: "org" });
			const data = input.dimension;
			const id = await withUniqueFields(() =>
				withScope({ ownerId: actor.userId, orgId: actor.orgId }, async (tx) => {
					const [row] = await tx
						.insert(classificationDimension)
						.values({
							org_id: actor.orgId,
							created_by: actor.userId,
							key: data.key,
							label: data.label,
							description: data.description ?? null,
							multi: data.multi ?? false,
							applies_to: data.applies_to ?? [],
							position: data.position ?? 0,
						})
						.returning({ id: classificationDimension.id });
					if (input.values.length > 0) {
						await tx.insert(classificationValue).values(
							input.values.map((v, i) => ({
								org_id: actor.orgId,
								dimension_id: row.id,
								value: v.value,
								label: v.label,
								color: v.color ?? null,
								position: i,
							})),
						);
					}
					return row.id;
				}),
			);
			return { id };
		},
	})(raw);
}

/** Persists a new dimension order (position = index). Ids must be in the org (RLS scopes it). */
export async function reorderDimensions(raw: z.input<typeof orderInput>): Promise<ActionResult<null>> {
	return defineAction({
		input: orderInput,
		run: async ({ input }) => {
			const actor = await authorize("edit", { type: "org" });
			await withScope({ ownerId: actor.userId, orgId: actor.orgId }, async (tx) => {
				for (let i = 0; i < input.ids.length; i++) {
					await tx
						.update(classificationDimension)
						.set({ position: i })
						.where(eq(classificationDimension.id, input.ids[i]));
				}
			});
			return null;
		},
	})(raw);
}

/** Persists a new value order within a dimension (position = index). */
export async function reorderValues(raw: z.input<typeof orderInput>): Promise<ActionResult<null>> {
	return defineAction({
		input: orderInput,
		run: async ({ input }) => {
			const actor = await authorize("edit", { type: "org" });
			await withScope({ ownerId: actor.userId, orgId: actor.orgId }, async (tx) => {
				for (let i = 0; i < input.ids.length; i++) {
					await tx
						.update(classificationValue)
						.set({ position: i })
						.where(eq(classificationValue.id, input.ids[i]));
				}
			});
			return null;
		},
	})(raw);
}
