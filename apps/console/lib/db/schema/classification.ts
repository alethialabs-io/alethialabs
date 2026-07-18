// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Structured resource classification (Workstream B). NOT free-form tags: a taxonomy of
// named dimensions (an axis, e.g. "Environment") × the allowed values on that axis
// (dev/staging/prod) × assignments that pin a value to a concrete resource. A dimension
// may be single- or multi-valued per resource (`multi`); the single-value rule is enforced
// in the server layer (a partial unique index can't reference the parent's `multi`), while
// the DB blocks exact duplicate assignments. Org-scoped (org_id is the RLS blast wall,
// filled by the set_org_id_from_created_by trigger in programmables.sql); the PDP authorizes
// mutations in the server actions.

import {
	index,
	boolean,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	unique,
	uuid,
} from "drizzle-orm/pg-core";
import { resourceKind } from "./enums";
import type { ClassificationEnforcement } from "@/types/jsonb.types";

// A named classification axis (e.g. "Environment", "Team", "Data classification").
// `key` is a stable slug unique within the org; `multi` decides whether a resource may
// hold one or many of this dimension's values.
export const classificationDimension = pgTable(
	"classification_dimension",
	{
		id: uuid().primaryKey().defaultRandom(),
		// Coarse tenancy scope (RLS blast wall); community org_id = created_by via trigger.
		org_id: uuid().notNull(),
		created_by: uuid().notNull(),
		// URL/wire-stable slug (lowercase); unique per org.
		key: text().notNull(),
		label: text().notNull(),
		description: text(),
		// false → at most one value per resource; true → many.
		multi: boolean().default(false).notNull(),
		// Which resource kinds this dimension may be applied to. Empty ⇒ ALL kinds (the
		// default, so existing dimensions keep applying everywhere). The picker filters by this;
		// the settings manager edits it. See resourceKind enum for the full set.
		applies_to: resourceKind().array().default([]).notNull(),
		// Display order in the picker + settings list.
		position: integer().default(0).notNull(),
		created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [
		unique("classification_dimension_org_key").on(t.org_id, t.key),
		index("idx_classification_dimension_org").on(t.org_id),
	],
);

// An allowed value on a dimension (e.g. "prod" on "Environment"). `value` is a slug
// unique within its dimension; `color` is an optional accent hint the chips honour.
export const classificationValue = pgTable(
	"classification_value",
	{
		id: uuid().primaryKey().defaultRandom(),
		org_id: uuid().notNull(),
		dimension_id: uuid()
			.notNull()
			.references(() => classificationDimension.id, { onDelete: "cascade" }),
		value: text().notNull(),
		label: text().notNull(),
		// Optional CSS colour string (hex/oklch); null renders the neutral chip.
		color: text(),
		// Promotion-gate policy this value imposes on any env carrying it (label drives policy);
		// null ⇒ inert (the default, so existing values enforce nothing). See gates.ts.
		enforcement: jsonb().$type<ClassificationEnforcement>(),
		position: integer().default(0).notNull(),
		created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [
		unique("classification_value_dimension_value").on(t.dimension_id, t.value),
		index("idx_classification_value_dimension").on(t.dimension_id),
		index("idx_classification_value_org").on(t.org_id),
	],
);

// A value pinned to a concrete resource. `resource_kind` + `resource_id` address any
// classifiable table (all uuid PKs). The (kind, id, value) uniqueness blocks assigning the
// SAME value twice; the single-value-per-dimension rule (for non-`multi` dimensions) is
// enforced transactionally in assignClassification (see server/actions/classification).
export const classificationAssignment = pgTable(
	"classification_assignment",
	{
		id: uuid().primaryKey().defaultRandom(),
		org_id: uuid().notNull(),
		dimension_id: uuid()
			.notNull()
			.references(() => classificationDimension.id, { onDelete: "cascade" }),
		value_id: uuid()
			.notNull()
			.references(() => classificationValue.id, { onDelete: "cascade" }),
		resource_kind: resourceKind().notNull(),
		resource_id: uuid().notNull(),
		assigned_by: uuid().notNull(),
		created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [
		// Exact-duplicate guard (same value on the same resource twice).
		unique("classification_assignment_resource_value").on(
			t.resource_kind,
			t.resource_id,
			t.value_id,
		),
		// Hydration for a resource's chips.
		index("idx_classification_assignment_resource").on(
			t.resource_kind,
			t.resource_id,
		),
		// "which resources carry value X" lookups.
		index("idx_classification_assignment_value").on(t.value_id),
		index("idx_classification_assignment_dimension").on(t.dimension_id),
		index("idx_classification_assignment_org").on(t.org_id),
	],
);

export type ClassificationDimension =
	typeof classificationDimension.$inferSelect;
export type NewClassificationDimension =
	typeof classificationDimension.$inferInsert;
export type ClassificationValue = typeof classificationValue.$inferSelect;
export type NewClassificationValue = typeof classificationValue.$inferInsert;
export type ClassificationAssignment =
	typeof classificationAssignment.$inferSelect;
export type NewClassificationAssignment =
	typeof classificationAssignment.$inferInsert;
