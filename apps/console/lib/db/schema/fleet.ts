// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Managed-fleet warm-pool projects (dataroom/spec/mvp/26-fleet-controller.md). One row = one
// declarative pool the Fleet Controller reconciles toward. This replaces the
// `FLEET_POOLS` env var so pools are editable live from the console (the controller
// re-reads enabled rows every tick). The managed fleet is platform-operator
// infrastructure shared across all orgs, so these rows are GLOBAL (no org_id / no RLS):
// all access goes through getServiceDb() gated by the `fleet` PDP resource (owner/admin).
// Column shapes mirror FleetTarget (lib/fleet/types.ts) + the env zod schema
// (lib/fleet/config.ts) 1:1.

import { sql } from "drizzle-orm";
import {
	boolean,
	index,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import type { FleetActionMetadata } from "@/types/jsonb.types";
import { cloudProvider, fleetActionType } from "./enums";
import { runners } from "./runners";

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
		// Paused pools are skipped for scale-up but still reconciled as a teardown target: the
		// controller DRAINS their warm VMs to zero (closing each runner's usage session) and
		// rebuilds them on resume — pausing never leaves billable orphans.
		enabled: boolean().default(true).notNull(),
		// A reconciled TEARDOWN request (not a hard delete). `deleteFleetPool` sets this instead of
		// removing the row, so the controller still sees the pool and can drain its VMs + close their
		// runner_usage_sessions before `reapDeletedPools` physically removes the now-empty row. A hard
		// DELETE would orphan every VM (perpetual cloud spend) and leave sessions billing forever.
		deleting: boolean().default(false).notNull(),
		created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
		updated_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [
		// One LIVE pool per provider keeps managed-runner attribution unambiguous. Partial (deleting
		// = false) so a fresh pool for a provider can be created while the old one still drains its
		// VMs (deleting = true) — the draining row is excluded from the uniqueness constraint.
		uniqueIndex("idx_fleet_pools_provider")
			.on(t.provider)
			.where(sql`deleting = false`),
	],
);

export type FleetPool = typeof fleetPools.$inferSelect;
export type NewFleetPool = typeof fleetPools.$inferInsert;

// Durable audit ledger of every managed-fleet controller action. `reconcilePool` records one
// row per applied action (create / drain / destroy) with the WHY (`reason`) and the decision
// inputs (queue depth + observed pool size) at that tick — so an operator can reconstruct why
// the fleet grew/shrank at 3am. Like fleet_pools this is GLOBAL platform infrastructure (no
// org_id / no RLS); all access is through getServiceDb() gated by the `fleet` PDP resource.
// Writes are best-effort in the controller: a ledger hiccup must never break a reconcile.
export const fleetActions = pgTable(
	"fleet_actions",
	{
		id: uuid().primaryKey().defaultRandom(),
		created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
		// The pool (provider) this action was taken against.
		provider: cloudProvider().notNull(),
		// What the controller did.
		action: fleetActionType().notNull(),
		// The correlated managed runner (drain/destroy). NULL for a create (no runner yet) — the
		// new VM's runner self-registers later. ON DELETE SET NULL so pruning a runner row keeps
		// its history readable.
		runner_id: uuid().references(() => runners.id, { onDelete: "set null" }),
		// Instances this action pertains to (usually 1; kept for a future batched action).
		count: integer().default(1).notNull(),
		// Machine-readable reason token (FleetActionReason), e.g. "scale-up-demand", "scale-down-idle".
		reason: text().notNull(),
		// Decision inputs captured at the tick: QUEUED backlog for the provider …
		queue_depth: integer(),
		// … and the observed live (online + booting) pool size.
		pool_size: integer(),
		// Free-form extra context (location, instance id, versions) for forensics.
		metadata: jsonb().$type<FleetActionMetadata>(),
	},
	(t) => [
		// The read path is "recent actions for a provider" (the later dashboard) — newest first.
		index("idx_fleet_actions_provider_time").on(t.provider, t.created_at.desc()),
		// The retention GC (gc_fleet_actions) filters + orders by created_at ALONE (no provider
		// predicate), so the (provider, created_at) index above can't serve it — its leading column is
		// unconstrained. This created_at-leading btree (ascending, matching `ORDER BY created_at`) turns
		// the GC's range scan + ordered LIMIT into an index scan instead of a seq-scan + sort.
		index("idx_fleet_actions_created_at").on(t.created_at),
	],
);

// Named *Row (not FleetAction) to avoid colliding with the planner's `FleetAction` action-union
// in lib/fleet/types.ts — this is the persisted ledger row, that is the in-memory decision.
export type FleetActionRow = typeof fleetActions.$inferSelect;
export type NewFleetActionRow = typeof fleetActions.$inferInsert;
