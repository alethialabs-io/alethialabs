// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Authorization tables (project 07 Part D). The PDP (lib/authz) owns these via the
// service connection; they are authz METADATA, not tenant data, so they are not
// under the per-tenant RLS. `resource_type`/`action` are text storing the registry
// keys — lib/authz/registry.ts (registry-as-code) is the single source of truth.

import {
	bigint,
	boolean,
	index,
	pgTable,
	primaryKey,
	text,
	timestamp,
	uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/** The permission registry, seeded from lib/authz/registry.ts. Key = `resource:action`. */
export const permission = pgTable("permission", {
	key: text().primaryKey(),
	resource: text().notNull(),
	action: text().notNull(),
	description: text().notNull(),
});

/** Roles. Built-ins have organization_id NULL + is_builtin; custom roles (ee/) are org-scoped copies. */
export const role = pgTable("role", {
	id: uuid().primaryKey().defaultRandom(),
	organization_id: uuid(),
	name: text().notNull(),
	/** Human description — built-ins seed from the registry; custom roles author their own. */
	description: text(),
	is_builtin: boolean().default(false).notNull(),
});

export const rolePermission = pgTable(
	"role_permission",
	{
		role_id: uuid()
			.notNull()
			.references(() => role.id, { onDelete: "cascade" }),
		permission_key: text()
			.notNull()
			.references(() => permission.key, { onDelete: "cascade" }),
	},
	(t) => [primaryKey({ columns: [t.role_id, t.permission_key] })],
);

/**
 * A grant: a principal gets a role OR a single permission at a scope, as an ALLOW or
 * an explicit DENY. resource_id NULL = org-wide (wildcard). A grant references EXACTLY
 * one of role_id / permission_key. Explicit deny overrides allow (IAM semantics) and
 * inherits down the hierarchy, so "view the org's projects EXCEPT project S" = an allow on
 * the org + a deny scoped to S.
 */
export const grants = pgTable(
	"grants",
	{
		id: uuid().primaryKey().defaultRandom(),
		org_id: uuid().notNull(),
		// 'user' | 'team' (text; the principal kind).
		principal_type: text().notNull(),
		principal_id: uuid().notNull(),
		// 'allow' | 'deny'. Deny wins over allow at any covered scope.
		effect: text().notNull().default("allow"),
		// A role bundle (XOR with permission_key) …
		role_id: uuid().references(() => role.id, { onDelete: "cascade" }),
		// … or a single permission key (XOR with role_id), for fine-grained grants/denies.
		permission_key: text().references(() => permission.key, {
			onDelete: "cascade",
		}),
		resource_type: text().notNull(),
		resource_id: uuid(),
		created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [
		index("idx_grants_org_principal").on(t.org_id, t.principal_id),
		index("idx_grants_effect").on(t.org_id, t.principal_id, t.effect),
	],
);

/** Org→Project edges the PDP walks (recursive CTE) so a higher grant flows down. */
export const resourceHierarchy = pgTable(
	"resource_hierarchy",
	{
		child_type: text().notNull(),
		child_id: uuid().notNull(),
		parent_type: text().notNull(),
		parent_id: uuid().notNull(),
	},
	(t) => [
		primaryKey({
			columns: [t.child_type, t.child_id, t.parent_type, t.parent_id],
		}),
		index("idx_resource_hierarchy_child").on(t.child_type, t.child_id),
	],
);

/** Append-only Activity log; written by the PDP on every enforce() (and by the explicit
 *  recordActivity seam for non-PDP governance events) so activity can't be skipped. Append-only
 *  is DB-ENFORCED in programmables.sql: an org-scoped RLS SELECT policy + a GC-aware WORM trigger
 *  (UPDATE/TRUNCATE always rejected; DELETE only via the retention GC) + REVOKE of mutation from
 *  the app role. */
export const authzActivityLog = pgTable(
	"authz_activity_log",
	{
		id: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
		org_id: uuid().notNull(),
		actor_id: uuid().notNull(),
		action: text().notNull(),
		resource_type: text().notNull(),
		resource_id: uuid(),
		// The resource's display name AS IT WAS when the event was written (#6735). The feed used to
		// resolve names live, so a deleted project's own deletion row read "deleted a project". Null on
		// rows written before this column, on org-wide resources (billing, the org itself), and on
		// people (member / invitation): a person's name is personal data, and this table is WORM —
		// it could never be erased from here, so it is never copied in.
		resource_name: text(),
		decision: boolean().notNull(),
		reason: text(),
		ts: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [
		// The hot read (lib/rpc/procedures/activity.ts + api/cli/activity) is
		// `WHERE org_id = ? [AND id < ?] ORDER BY id DESC LIMIT n` — a per-org keyset
		// page, newest first. A composite (org_id, id DESC) btree serves the org filter,
		// the `id <` cursor bound, AND the descending order as a single index range scan,
		// so paging is a bounded probe instead of an org-index scan + in-memory sort. This
		// SUPERSEDES a standalone (org_id) index (a lone org filter is just a prefix of this
		// one), so we don't keep the old idx_authz_activity_org — it would be redundant.
		//
		// NULLS FIRST is what makes that true (#7539). drizzle's `.desc()` alone emits DESC NULLS
		// LAST, and a bare `ORDER BY id DESC` means NULLS FIRST; the planner does not treat the two
		// as the same order even on a NOT NULL column, so for months this index served only the
		// org filter and every page was sorted on top of it (or walked the pkey backwards). Its
		// EXPLAIN test passed while it was the only index leading with org_id, and went red the
		// moment a second one did.
		index("idx_authz_activity_org_id_desc").on(t.org_id, t.id.desc().nullsFirst()),
		// The Settings › Activity read (lib/queries/activity.ts, the console keyset contract since
		// LST-10 #7492) is `WHERE org_id = ? [AND (sort_key, id) < (?, ?)] ORDER BY sort_key DESC,
		// id DESC LIMIT n`, with sort_key the instant truncated to the millisecond. This serves the
		// org filter, the row-value cursor bound and the order as one range scan, so a large org's
		// wide window is no longer sorted in memory (#7539). The expression is the UTC form
		// (`keysetUtcSortKey`): `date_trunc(text, timestamptz)` is STABLE and cannot be indexed,
		// the `timestamp` overload is IMMUTABLE, and the order is the same. It must match the
		// query's expression exactly — a different spelling of the same order is a silent sort.
		// `id` is DESC NULLS FIRST on purpose: that is what the query's bare `id desc` means, and
		// drizzle's `.desc()` alone emits NULLS LAST, which the planner treats as a different
		// order (it then adds an Incremental Sort on id) even though the column is NOT NULL.
		index("idx_authz_activity_org_ts_ms_id").on(
			t.org_id,
			sql`date_trunc('milliseconds', (${t.ts} at time zone 'UTC')) desc`,
			t.id.desc().nullsFirst(),
		),
		// Retention GC (gc_authz_activity_log) range-scans `ts < now() - p_age` and takes the
		// oldest first (ORDER BY ts) with no org predicate, so the (org_id, id) index above
		// can't serve it — its leading org_id column is unconstrained. This ts btree
		// (ascending, matching `ORDER BY ts`) turns the GC's range filter + ordered LIMIT into
		// an index scan instead of a seq-scan + sort every pass. Mirrors idx_fleet_actions_created_at.
		index("idx_authz_activity_ts").on(t.ts),
	],
);

export type Permission = typeof permission.$inferSelect;
export type Role = typeof role.$inferSelect;
export type Grant = typeof grants.$inferSelect;
export type ResourceHierarchyEdge = typeof resourceHierarchy.$inferSelect;
