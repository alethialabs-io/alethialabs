// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { sql } from "drizzle-orm";
import {
	type AnyPgColumn,
	bigint,
	index,
	jsonb,
	pgTable,
	text,
	timestamp,
	uuid,
} from "drizzle-orm/pg-core";
import { logStreamType, provisionJobStatus, provisionJobType } from "./enums";
import { cloudIdentities } from "./identities";
import { runners } from "./runners";
import { specs } from "./specs";
import { zones } from "./zones";

// Unified provisioning job queue. Claimed atomically by runners via the
// claim_next_job RPC (FOR UPDATE SKIP LOCKED). `zone_id` is denormalized
// (NOT NULL) so worker-lifecycle jobs — which have no spec — still carry a
// scope; a trigger keeps it consistent with the spec's zone when spec_id is set.
export const jobs = pgTable(
	"jobs",
	{
		id: uuid().primaryKey().defaultRandom(),
		user_id: uuid().notNull(),
		// Nullable: jobs always have a runner but not necessarily a zone —
		// cloud-hosted runners and worker-lifecycle / FETCH_RESOURCES /
		// CONNECTION_TEST jobs have no spec → no zone. Denormalized scope for
		// spec jobs only (kept in sync by the jobs_sync_zone trigger).
		zone_id: uuid().references(() => zones.id, { onDelete: "set null" }),
		spec_id: uuid().references(() => specs.id, { onDelete: "set null" }),
		cloud_identity_id: uuid().references(() => cloudIdentities.id, {
			onDelete: "set null",
		}),
		job_type: provisionJobType().notNull(),
		config_snapshot: jsonb()
			.$type<Record<string, unknown>>()
			.default({})
			.notNull(),
		configuration_hash: text(),
		status: provisionJobStatus().default("QUEUED").notNull(),
		runner_id: uuid().references(() => runners.id, { onDelete: "set null" }),
		assigned_runner_id: uuid().references(() => runners.id, {
			onDelete: "set null",
		}),
		plan_job_id: uuid().references((): AnyPgColumn => jobs.id, {
			onDelete: "set null",
		}),
		claimed_at: timestamp({ withTimezone: true }),
		started_at: timestamp({ withTimezone: true }),
		completed_at: timestamp({ withTimezone: true }),
		error_message: text(),
		execution_metadata: jsonb().$type<Record<string, unknown>>(),
		created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
		updated_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [
		index("idx_jobs_user").on(t.user_id),
		index("idx_jobs_zone").on(t.zone_id),
		// FIFO claim index — the hot path for claim_next_job.
		index("idx_jobs_queue")
			.on(t.status, t.created_at)
			.where(sql`status = 'QUEUED'`),
		index("idx_jobs_assigned_runner")
			.on(t.assigned_runner_id)
			.where(sql`assigned_runner_id IS NOT NULL`),
	],
);

export const jobLogs = pgTable(
	"job_logs",
	{
		id: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
		job_id: uuid()
			.notNull()
			.references(() => jobs.id, { onDelete: "cascade" }),
		log_chunk: text().notNull(),
		stream_type: logStreamType().default("STDOUT").notNull(),
		created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [index("idx_job_logs_job_id").on(t.job_id)],
);

export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
export type JobLog = typeof jobLogs.$inferSelect;
