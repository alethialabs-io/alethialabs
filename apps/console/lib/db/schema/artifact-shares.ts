// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import {
	index,
	pgTable,
	text,
	timestamp,
	unique,
	uuid,
} from "drizzle-orm/pg-core";
import { agentArtifacts } from "./widgets";

// Share grants for a saved artifact — a SERVICE-OWNED ACL (like `grants`), deliberately NOT
// under the owner_all tenant RLS: a share must be visible to OTHER members, which the per-owner
// RLS can't express. Read/written only via getServiceDb() with explicit org + principal scoping.
//   scope_type 'org'  → the whole org (scope_id NULL)
//   scope_type 'team' → one team      (scope_id = team.id)
//   scope_type 'role' → everyone holding a role (scope_id = role.id, resolved via `grants`)
// Artifacts stay private to their creator until a row here grants them out.
export const agentArtifactShares = pgTable(
	"agent_artifact_shares",
	{
		id: uuid().primaryKey().defaultRandom(),
		artifact_id: uuid()
			.notNull()
			.references(() => agentArtifacts.id, { onDelete: "cascade" }),
		org_id: uuid().notNull(),
		scope_type: text().$type<"org" | "team" | "role">().notNull(),
		scope_id: uuid(),
		created_by: uuid().notNull(),
		created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [
		unique("uq_artifact_share_target")
			.on(t.artifact_id, t.scope_type, t.scope_id)
			.nullsNotDistinct(),
		index("idx_artifact_shares_org").on(t.org_id),
		index("idx_artifact_shares_artifact").on(t.artifact_id),
	],
);

export type AgentArtifactShare = typeof agentArtifactShares.$inferSelect;
export type NewAgentArtifactShare = typeof agentArtifactShares.$inferInsert;
