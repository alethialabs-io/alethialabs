// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Managed-fleet warm-pool specs (dataroom/spec/mvp/26-fleet-controller.md). One row = one
// declarative pool the Fleet Controller reconciles toward. This replaces the
// `FLEET_POOLS` env var so pools are editable live from the console (the controller
// re-reads enabled rows every tick). The managed fleet is platform-operator
// infrastructure shared across all orgs, so these rows are GLOBAL (no org_id / no RLS):
// all access goes through getServiceDb() gated by the `fleet` PDP resource (owner/admin).
// Column shapes mirror FleetSpec (lib/fleet/types.ts) + the env zod schema
// (lib/fleet/config.ts) 1:1.

import {
	boolean,
	integer,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import { cloudProvider } from "./enums";

export const fleetPools = pgTable(
	"fleet_pools",
	{
		id: uuid().primaryKey().defaultRandom(),
		// Target cloud the runners provision into (one pool per provider).
		provider: cloudProvider().notNull(),
		// Optional human label for the UI; falls back to the provider name.
		name: text(),
		// Always-warm floor; auto-grow lifts the effective floor toward recent peak.
		warm_min: integer().default(1).notNull(),
		// Hard ceiling on instances.
		max: integer().default(10).notNull(),
		// Concurrent jobs one runner handles; divides backlog into runner demand.
		slots_per_runner: integer().default(1).notNull(),
		// Locations to spread across (≥1), e.g. ["fsn1","nbg1"].
		locations: text().array().default(["fsn1"]).notNull(),
		// Minimum healthy instances to keep in each listed location.
		min_per_location: integer().default(0).notNull(),
		// Max extra instances allowed above the floor during a rollout (maxSurge).
		surge: integer().default(1).notNull(),
		// Headroom added over observed demand so an idle spare always exists (N+1).
		buffer: integer().default(1).notNull(),
		// Consecutive ticks an instance must be surplus before idle scale-down.
		scale_down_grace_ticks: integer().default(5).notNull(),
		// Exact image/version pin; null = resolve from `channel` (or don't version-reconcile).
		version: text(),
		// Release channel (e.g. "stable") resolved to the newest release each tick.
		channel: text(),
		// Paused pools are skipped by the controller (kept for quick resume).
		enabled: boolean().default(true).notNull(),
		created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
		updated_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [
		// One pool per provider keeps managed-runner attribution unambiguous.
		uniqueIndex("idx_fleet_pools_provider").on(t.provider),
	],
);

export type FleetPool = typeof fleetPools.$inferSelect;
export type NewFleetPool = typeof fleetPools.$inferInsert;
