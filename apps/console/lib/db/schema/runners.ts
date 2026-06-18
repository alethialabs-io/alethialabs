// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { sql } from "drizzle-orm";
import {
	boolean,
	check,
	index,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import type { WorkerMetadata } from "@/types/database-custom.types";
import { workerMode, workerStatus } from "./enums";
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

// Runner — the worker that executes provisioning. `user_id` is null for
// cloud-hosted runners (platform-owned, public-read); set for self-hosted.
export const runners = pgTable(
	"runners",
	{
		id: uuid().primaryKey().defaultRandom(),
		user_id: uuid(),
		name: text().notNull(),
		mode: workerMode().notNull(),
		cloud_identity_id: uuid().references(() => cloudIdentities.id, {
			onDelete: "set null",
		}),
		token_hash: text().notNull(),
		status: workerStatus().default("OFFLINE"),
		last_heartbeat: timestamp({ withTimezone: true }),
		version: text(),
		release_id: uuid().references(() => runnerReleases.id),
		is_default: boolean().default(false).notNull(),
		metadata: jsonb().$type<WorkerMetadata>().default({}),
		created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [
		index("idx_runners_user").on(t.user_id),
		index("idx_runners_token_hash").on(t.id, t.token_hash),
		uniqueIndex("idx_runners_one_default_per_user")
			.on(t.user_id)
			.where(sql`is_default = true`),
		uniqueIndex("idx_runners_unique_cloud_name")
			.on(t.name)
			.where(sql`mode = 'cloud-hosted'`),
		// Cloud-hosted runners are platform-owned (no user); self-hosted have an owner.
		check(
			"runners_mode_owner_ck",
			sql`(${t.mode} = 'cloud-hosted') = (${t.user_id} IS NULL)`,
		),
	],
);

export type Runner = typeof runners.$inferSelect;
export type NewRunner = typeof runners.$inferInsert;
export type RunnerRelease = typeof runnerReleases.$inferSelect;
