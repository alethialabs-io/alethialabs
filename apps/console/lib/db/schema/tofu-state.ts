// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { bigint, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { jobs } from "./jobs";

/**
 * Advisory locks for the console tofu-state HTTP backend (E0 isolation runtime). One row per
 * state object (`state_key` = `projects/{project_id}/{environment_id}/tofu.tfstate`); tofu holds
 * it for the duration of an apply via the backend's lock/unlock endpoints.
 *
 * `lock_id` is tofu's own lock ID and acts as the **fencing token**: the state-write POST must
 * present the currently-held lock_id (tofu appends it as `?ID=`), or it is rejected. So a lock
 * stolen after `expires_at` (only a crashed-runner safety valve — `expires_at` is set well beyond
 * the max apply, so a live apply is never stolen) changes lock_id + bumps `generation`, and a slow
 * writer's stale id then fails closed — no lost update. `info` is tofu's lock-info JSON, returned
 * verbatim in the 423 body on a conflict so tofu can report who holds the lock.
 */
export const tofuStateLocks = pgTable("tofu_state_locks", {
	state_key: text().primaryKey(),
	lock_id: text().notNull(),
	generation: bigint({ mode: "number" }).notNull().default(1),
	job_id: uuid().references(() => jobs.id, { onDelete: "set null" }),
	info: jsonb().$type<Record<string, unknown>>().notNull(),
	locked_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
	expires_at: timestamp({ withTimezone: true }).notNull(),
});

export type TofuStateLock = typeof tofuStateLocks.$inferSelect;
