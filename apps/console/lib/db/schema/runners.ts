// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { sql } from "drizzle-orm";
import {
	bigint,
	boolean,
	index,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import type { RunnerMetadata } from "@/types/database-custom.types";
import {
	cloudProvider,
	runnerMode,
	runnerOperator,
	runnerProvisioning,
	runnerStatus,
} from "./enums";
import { cloudIdentities } from "./identities";

export const runnerReleases = pgTable("runner_releases", {
	id: uuid().primaryKey().defaultRandom(),
	version: text().notNull().unique(),
	release_notes: text().default("").notNull(),
	released_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
	commit_sha: text(),
	github_release_url: text(),
	is_breaking: boolean().default(false).notNull(),
});

// Runner — the runner that executes provisioning. `user_id` is null for
// managed runners (Alethia-operated, platform-owned, public-read); set for
// self-operated runners.
export const runners = pgTable(
	"runners",
	{
		id: uuid().primaryKey().defaultRandom(),
		user_id: uuid(),
		// Coarse tenancy scope; null for managed runners (platform-owned,
		// public-read), org_id = user_id for self-operated (trigger backfill).
		org_id: uuid(),
		name: text().notNull(),
		// Who operates & bills the runner. `managed` ⇔ user_id IS NULL (enforced by
		// runners_operator_owner_ck in programmables.sql).
		operator: runnerOperator().notNull().default("self"),
		// How a self-operated runner was provisioned. Null for managed (enforced by
		// runners_provisioning_ck in programmables.sql).
		provisioning: runnerProvisioning(),
		// Cloud providers this runner can execute jobs for (per-cloud routing). NULL =
		// claims any provider (the full/self-host image); a lean per-cloud image
		// declares just its one. Reported image-driven via the heartbeat.
		supported_providers: cloudProvider().array(),
		// @deprecated superseded by operator/provisioning; retained nullable for the
		// backfill window, dropped in a later migration.
		mode: runnerMode(),
		cloud_identity_id: uuid().references(() => cloudIdentities.id, {
			onDelete: "set null",
		}),
		token_hash: text().notNull(),
		status: runnerStatus().default("OFFLINE"),
		last_heartbeat: timestamp({ withTimezone: true }),
		version: text(),
		release_id: uuid().references(() => runnerReleases.id),
		is_default: boolean().default(false).notNull(),
		metadata: jsonb().$type<RunnerMetadata>().default({}),
		created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [
		index("idx_runners_user").on(t.user_id),
		index("idx_runners_org").on(t.org_id),
		index("idx_runners_token_hash").on(t.id, t.token_hash),
		uniqueIndex("idx_runners_one_default_per_user")
			.on(t.user_id)
			.where(sql`is_default = true`),
		// Managed (platform-owned) runner names are globally unique.
		uniqueIndex("idx_runners_unique_managed_name")
			.on(t.name)
			.where(sql`operator = 'managed'`),
		// NB: the operator↔owner and provisioning invariants are CHECK constraints
		// added in programmables.sql after the backfill, since they would not hold
		// against pre-backfill rows.
	],
);

// Usage ledger for managed-runner billing. One row per ONLINE→OFFLINE interval;
// managed runners scale-to-zero and cycle many times per billing period, so a
// pair of columns on `runners` cannot represent the history. `operator` is
// snapshotted at open so reclassifying a runner never rewrites past billing.
export const runnerUsageSessions = pgTable(
	"runner_usage_sessions",
	{
		id: uuid().primaryKey().defaultRandom(),
		runner_id: uuid()
			.notNull()
			.references(() => runners.id, { onDelete: "cascade" }),
		operator: runnerOperator().notNull(),
		org_id: uuid(),
		started_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
		ended_at: timestamp({ withTimezone: true }),
		// Provisioned seconds, set when the session closes. Null while open.
		duration_seconds: bigint({ mode: "number" }),
		created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [
		// At most one open session per runner — open/close logic relies on this.
		uniqueIndex("idx_usage_one_open_per_runner")
			.on(t.runner_id)
			.where(sql`ended_at IS NULL`),
		index("idx_usage_runner_started").on(t.runner_id, t.started_at),
		index("idx_usage_operator_started")
			.on(t.operator, t.started_at)
			.where(sql`operator = 'managed'`),
	],
);

export type Runner = typeof runners.$inferSelect;
export type NewRunner = typeof runners.$inferInsert;
export type RunnerRelease = typeof runnerReleases.$inferSelect;
export type RunnerUsageSession = typeof runnerUsageSessions.$inferSelect;
