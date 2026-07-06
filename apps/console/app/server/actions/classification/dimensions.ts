"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Server actions for the classification taxonomy — CRUD over dimensions (named axes) and
// their allowed values. Reads gate on `org:view`, mutations on `org:edit` (classification is
// org-wide taxonomy; a dedicated PDP resource is a follow-up). Every query runs inside
// withScope so RLS (org-scoped dimensions, parent-scoped values) is the tenancy wall.

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { authorize } from "@/lib/authz/guard";
import { withScope } from "@/lib/db";
import {
	classificationDimension,
	classificationValue,
} from "@/lib/db/schema";
import {
	type DimensionInput,
	dimensionInputSchema,
	type ValueInput,
	valueInputSchema,
} from "@/lib/validations/classification";
import {
	type DimensionWithValues,
	listDimensionsWithValues,
} from "@/lib/queries/classification";

/** Client-safe value DTO (no org_id). */
export interface ValueDTO {
	id: string;
	dimension_id: string;
	value: string;
	label: string;
	color: string | null;
	position: number;
}

/** Client-safe dimension DTO with its values nested. */
export interface DimensionDTO {
	id: string;
	key: string;
	label: string;
	description: string | null;
	multi: boolean;
	position: number;
	values: ValueDTO[];
}

/** Maps a hydrated dimension row to its client-safe DTO. */
function toDimensionDTO(d: DimensionWithValues): DimensionDTO {
	return {
		id: d.id,
		key: d.key,
		label: d.label,
		description: d.description,
		multi: d.multi,
		position: d.position,
		values: d.values.map((v) => ({
			id: v.id,
			dimension_id: v.dimension_id,
			value: v.value,
			label: v.label,
			color: v.color,
			position: v.position,
		})),
	};
}

const CLASSIFICATION_PATH = "/dashboard/settings/classification";

/** Lists every classification dimension in the org with its allowed values nested. */
export async function listDimensions(): Promise<DimensionDTO[]> {
	const actor = await authorize("view", { type: "org" });
	const dims = await withScope(
		{ ownerId: actor.userId, orgId: actor.orgId },
		(tx) => listDimensionsWithValues(tx),
	);
	return dims.map(toDimensionDTO);
}

/** Creates a dimension (an axis). Returns its new id. */
export async function createDimension(
	input: DimensionInput,
): Promise<{ id: string }> {
	const actor = await authorize("edit", { type: "org" });
	const data = dimensionInputSchema.parse(input);
	const id = await withScope(
		{ ownerId: actor.userId, orgId: actor.orgId },
		async (tx) => {
			const [row] = await tx
				.insert(classificationDimension)
				.values({
					org_id: actor.orgId,
					created_by: actor.userId,
					key: data.key,
					label: data.label,
					description: data.description ?? null,
					multi: data.multi ?? false,
					position: data.position ?? 0,
				})
				.returning({ id: classificationDimension.id });
			return row.id;
		},
	);
	revalidatePath(CLASSIFICATION_PATH);
	return { id };
}

/** Updates a dimension's presentation + single/multi mode. */
export async function updateDimension(
	id: string,
	input: DimensionInput,
): Promise<void> {
	const actor = await authorize("edit", { type: "org" });
	const data = dimensionInputSchema.parse(input);
	await withScope({ ownerId: actor.userId, orgId: actor.orgId }, (tx) =>
		tx
			.update(classificationDimension)
			.set({
				key: data.key,
				label: data.label,
				description: data.description ?? null,
				multi: data.multi ?? false,
				position: data.position ?? 0,
			})
			.where(eq(classificationDimension.id, id)),
	);
	revalidatePath(CLASSIFICATION_PATH);
}

/** Deletes a dimension; its values + assignments cascade (FK ON DELETE cascade). */
export async function deleteDimension(id: string): Promise<void> {
	const actor = await authorize("edit", { type: "org" });
	await withScope({ ownerId: actor.userId, orgId: actor.orgId }, (tx) =>
		tx
			.delete(classificationDimension)
			.where(eq(classificationDimension.id, id)),
	);
	revalidatePath(CLASSIFICATION_PATH);
}

/** Adds an allowed value to a dimension. Returns its new id. */
export async function createValue(
	dimensionId: string,
	input: ValueInput,
): Promise<{ id: string }> {
	const actor = await authorize("edit", { type: "org" });
	const data = valueInputSchema.parse(input);
	const id = await withScope(
		{ ownerId: actor.userId, orgId: actor.orgId },
		async (tx) => {
			// Confirm the dimension is in scope (RLS already blocks cross-org) before
			// stamping the child row's denormalized org_id.
			const [dim] = await tx
				.select({ id: classificationDimension.id })
				.from(classificationDimension)
				.where(eq(classificationDimension.id, dimensionId))
				.limit(1);
			if (!dim) throw new Error("Dimension not found");
			const [row] = await tx
				.insert(classificationValue)
				.values({
					org_id: actor.orgId,
					dimension_id: dimensionId,
					value: data.value,
					label: data.label,
					color: data.color ?? null,
					position: data.position ?? 0,
				})
				.returning({ id: classificationValue.id });
			return row.id;
		},
	);
	revalidatePath(CLASSIFICATION_PATH);
	return { id };
}

/** Updates a value's presentation. */
export async function updateValue(
	id: string,
	input: ValueInput,
): Promise<void> {
	const actor = await authorize("edit", { type: "org" });
	const data = valueInputSchema.parse(input);
	await withScope({ ownerId: actor.userId, orgId: actor.orgId }, (tx) =>
		tx
			.update(classificationValue)
			.set({
				value: data.value,
				label: data.label,
				color: data.color ?? null,
				position: data.position ?? 0,
			})
			.where(eq(classificationValue.id, id)),
	);
	revalidatePath(CLASSIFICATION_PATH);
}

/** Deletes a value; its assignments cascade. */
export async function deleteValue(id: string): Promise<void> {
	const actor = await authorize("edit", { type: "org" });
	await withScope({ ownerId: actor.userId, orgId: actor.orgId }, (tx) =>
		tx
			.delete(classificationValue)
			.where(and(eq(classificationValue.id, id))),
	);
	revalidatePath(CLASSIFICATION_PATH);
}
