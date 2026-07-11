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
import type { ResourceKind } from "@/lib/db/schema/enums";
import type { ClassificationEnforcement } from "@/types/jsonb.types";
import {
	type DimensionInput,
	dimensionInputSchema,
	type ValueInput,
	valueInputSchema,
} from "@/lib/validations/classification";
import {
	countAssignmentsByValue,
	countResourcesByDimension,
	type DimensionWithValues,
	listDimensionsWithValues,
} from "@/lib/queries/classification";

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

/** Maps a hydrated dimension row to its client-safe DTO, merging usage counts. */
function toDimensionDTO(
	d: DimensionWithValues,
	byValue: Map<string, number>,
	byDimension: Map<string, number>,
): DimensionDTO {
	return {
		id: d.id,
		key: d.key,
		label: d.label,
		description: d.description,
		multi: d.multi,
		position: d.position,
		appliesTo: d.applies_to ?? [],
		resourceCount: byDimension.get(d.id) ?? 0,
		values: d.values.map((v) => ({
			id: v.id,
			dimension_id: v.dimension_id,
			value: v.value,
			label: v.label,
			color: v.color,
			enforcement: v.enforcement,
			position: v.position,
			assignmentCount: byValue.get(v.id) ?? 0,
		})),
	};
}

const CLASSIFICATION_PATH = "/dashboard/settings/classification";

/**
 * Lists the org's classification dimensions with values + usage counts nested. When `search`
 * is provided the dimension list is filtered server-side (label/key or a matching value);
 * the usage counts are org-wide and merged by id, so a filtered list still shows real numbers.
 */
export async function listDimensions(search?: string): Promise<DimensionDTO[]> {
	const actor = await authorize("view", { type: "org" });
	const { dims, byValue, byDimension } = await withScope(
		{ ownerId: actor.userId, orgId: actor.orgId },
		async (tx) => ({
			dims: await listDimensionsWithValues(tx, search),
			byValue: await countAssignmentsByValue(tx),
			byDimension: await countResourcesByDimension(tx),
		}),
	);
	return dims.map((d) => toDimensionDTO(d, byValue, byDimension));
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
					applies_to: data.applies_to ?? [],
					position: data.position ?? 0,
				})
				.returning({ id: classificationDimension.id });
			return row.id;
		},
	);
	revalidatePath(CLASSIFICATION_PATH);
	return { id };
}

/** Updates a dimension's presentation, single/multi mode, and resource-kind scope. */
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
				applies_to: data.applies_to ?? [],
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
					enforcement: data.enforcement ?? null,
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
				enforcement: data.enforcement ?? null,
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

/** One value in a template / bulk create (presentation only; server stamps the rest). */
export interface SeedValue {
	value: string;
	label: string;
	color?: string | null;
}

/**
 * Creates a dimension together with its initial values in one transaction — powers the
 * empty-state starter templates (and any bulk author). Returns the new dimension id.
 */
export async function createDimensionWithValues(
	input: DimensionInput,
	values: SeedValue[],
): Promise<{ id: string }> {
	const actor = await authorize("edit", { type: "org" });
	const data = dimensionInputSchema.parse(input);
	const seeds = values.map((v) =>
		valueInputSchema.parse({ value: v.value, label: v.label, color: v.color ?? undefined }),
	);
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
					applies_to: data.applies_to ?? [],
					position: data.position ?? 0,
				})
				.returning({ id: classificationDimension.id });
			if (seeds.length > 0) {
				await tx.insert(classificationValue).values(
					seeds.map((v, i) => ({
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
		},
	);
	revalidatePath(CLASSIFICATION_PATH);
	return { id };
}

/** Persists a new dimension order (position = index). Ids must be in the org (RLS scopes it). */
export async function reorderDimensions(ids: string[]): Promise<void> {
	const actor = await authorize("edit", { type: "org" });
	await withScope({ ownerId: actor.userId, orgId: actor.orgId }, async (tx) => {
		for (let i = 0; i < ids.length; i++) {
			await tx
				.update(classificationDimension)
				.set({ position: i })
				.where(eq(classificationDimension.id, ids[i]));
		}
	});
	revalidatePath(CLASSIFICATION_PATH);
}

/** Persists a new value order within a dimension (position = index). */
export async function reorderValues(ids: string[]): Promise<void> {
	const actor = await authorize("edit", { type: "org" });
	await withScope({ ownerId: actor.userId, orgId: actor.orgId }, async (tx) => {
		for (let i = 0; i < ids.length; i++) {
			await tx
				.update(classificationValue)
				.set({ position: i })
				.where(eq(classificationValue.id, ids[i]));
		}
	});
	revalidatePath(CLASSIFICATION_PATH);
}
