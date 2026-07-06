// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Better Auth organization-plugin TEAMS tables (org-scoped groups). Like the other
// org-plugin tables they live in the core schema (so the drizzleAdapter knows them)
// but are INERT in the community build. A grant can target a team
// (grants.principal_type = 'team'); both PDP engines resolve team membership →
// team_member here. camelCase keys (casing→snake_case columns), uuid ids.
//
// Best-effort match to better-auth 1.6.19; reconcile vs `@better-auth/cli generate`.

import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { organization } from "./organizations";

export const team = pgTable("team", {
	id: uuid().primaryKey().defaultRandom(),
	name: text().notNull(),
	organizationId: uuid()
		.notNull()
		.references(() => organization.id, { onDelete: "cascade" }),
	createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
	updatedAt: timestamp({ withTimezone: true }),
});

export const teamMember = pgTable("team_member", {
	id: uuid().primaryKey().defaultRandom(),
	teamId: uuid()
		.notNull()
		.references(() => team.id, { onDelete: "cascade" }),
	userId: uuid()
		.notNull()
		.references(() => user.id, { onDelete: "cascade" }),
	createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
});

export type Team = typeof team.$inferSelect;
export type TeamMember = typeof teamMember.$inferSelect;
