// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Minimal drizzle refs for the two console-owned tables the staff joins touch:
// `organization` (case → owning org name/slug) and `user` (case → assignee / customer
// name+email). The console owns these tables + their migrations; here we declare ONLY
// the columns the staff queries read, mirroring the physical schema
// (apps/console/lib/db/schema/{organizations,auth}.ts). No migrations are generated here.

import { pgTable, text, uuid } from "drizzle-orm/pg-core";

/** Owning organization of a support case — name + slug for the staff list/detail. */
export const organization = pgTable("organization", {
	id: uuid().primaryKey().defaultRandom(),
	name: text().notNull(),
	slug: text().unique(),
});

/** A platform user — the case customer and (for `assigned_staff_id`) the staff assignee. */
export const user = pgTable("user", {
	id: uuid().primaryKey().defaultRandom(),
	name: text(),
	email: text().notNull().unique(),
});
