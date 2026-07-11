// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Input validators for the classification server actions (drizzle-zod over the schema,
// refined for the settings forms). Keys/values are lowercase slugs (URL/wire-stable);
// server-managed columns (id, org_id, author, created_at) are omitted from the form shapes.

import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import {
	classificationAssignment,
	classificationDimension,
	classificationValue,
} from "@/lib/db/schema";
import { resourceKind } from "@/lib/db/schema/enums";

/** A lowercase, dash/underscore slug (used for dimension `key` and value `value`). */
export const slugSchema = z
	.string()
	.min(1)
	.max(64)
	.regex(
		/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/,
		"Use lowercase letters, numbers, and single - or _ separators.",
	);

/** The resource-kind enum as a zod enum (shared by the assignment schemas). */
export const resourceKindSchema = z.enum(resourceKind.enumValues);

// ── Dimensions ────────────────────────────────────────────────────────────────────

/** Create/update a dimension. `key` is immutable-friendly but validated on both paths. */
export const dimensionInputSchema = createInsertSchema(classificationDimension, {
	key: slugSchema,
	label: z.string().min(1).max(80),
	description: z.string().max(280).optional(),
	// Kept `.optional()` (not `.default()`) so the schema's input and output types match —
	// react-hook-form's resolver needs that. The server actions apply the defaults.
	multi: z.boolean().optional(),
	// Resource kinds this dimension applies to; empty/omitted ⇒ all kinds.
	applies_to: z.array(resourceKindSchema).optional(),
	position: z.number().int().min(0).optional(),
}).pick({
	key: true,
	label: true,
	description: true,
	multi: true,
	applies_to: true,
	position: true,
});

export type DimensionInput = z.infer<typeof dimensionInputSchema>;

// ── Values ────────────────────────────────────────────────────────────────────────

/** An optional CSS colour hint (hex or oklch); blank clears it. */
const colorSchema = z
	.string()
	.max(32)
	.regex(
		/^(#[0-9a-fA-F]{3,8}|oklch\([^)]*\)|[a-z]+)$/,
		"Use a hex, oklch(), or named colour.",
	)
	.optional();

/**
 * The promotion-gate policy a value imposes on envs carrying it (label drives policy).
 * `null` on the form ⇒ the value enforces nothing (the default).
 */
export const enforcementSchema = z.object({
	require_approval: z.boolean(),
	require_verify_pass: z.boolean(),
	min_approvals: z.number().int().min(1).max(10),
});

export type EnforcementInput = z.infer<typeof enforcementSchema>;

/** Create/update an allowed value on a dimension. */
export const valueInputSchema = createInsertSchema(classificationValue, {
	value: slugSchema,
	label: z.string().min(1).max(80),
	color: colorSchema,
	// Optional gate policy; nullable so the form can clear it. Server writes null when absent.
	enforcement: enforcementSchema.nullable().optional(),
	position: z.number().int().min(0).optional(),
}).pick({
	value: true,
	label: true,
	color: true,
	enforcement: true,
	position: true,
});

export type ValueInput = z.infer<typeof valueInputSchema>;

// ── Assignments ─────────────────────────────────────────────────────────────────────

/** Pin a value to a resource. `dimension_id` is derived server-side from the value. */
export const assignInputSchema = createInsertSchema(classificationAssignment, {
	value_id: z.string().uuid(),
	resource_kind: resourceKindSchema,
	resource_id: z.string().uuid(),
}).pick({
	value_id: true,
	resource_kind: true,
	resource_id: true,
});

export type AssignInput = z.infer<typeof assignInputSchema>;

/** Clear a single value assignment from a resource. */
export const unassignInputSchema = z.object({
	value_id: z.string().uuid(),
	resource_kind: resourceKindSchema,
	resource_id: z.string().uuid(),
});

export type UnassignInput = z.infer<typeof unassignInputSchema>;
