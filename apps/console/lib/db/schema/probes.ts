// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Live cluster-alive signal per project environment (BYOC B2) — the "is it still up?" half of
// day-2, alongside drift ("has it diverged?"). A PROBE_CLUSTER job dials the env's cluster API
// server and the runner writes ONE honest environment_probes row here. Unlike environment_drift
// (one upserted row per env — the latest posture), this is an APPEND-ONLY history: every probe
// is a new row so a true→false liveness transition (and its timing) is durably recorded. The
// console/reconcile view reads the latest row per env (ORDER BY probed_at DESC LIMIT 1) and can
// walk the history for a timeline. Like environment_drift, writes/reads are SERVER-SIDE ONLY via
// the service role (getServiceDb, RLS-bypassing) — the runner's job-status route ingests the
// result and getEnvReconcileStates reads it — so this table carries no explicit RLS policy, exactly
// mirroring its sibling. It links a tenant (project_id/environment_id) but is never touched through
// a tenant (withOwnerScope) connection.

import { boolean, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { ProbeDetail } from "@/types/jsonb.types";
import { projectEnvironments } from "./project-environments";
import { projects } from "./projects";

export const environmentProbes = pgTable(
	"environment_probes",
	{
		id: uuid().primaryKey().defaultRandom(),
		project_id: uuid()
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		// The probed environment. NOT NULL — a probe always targets one env's cluster (unlike drift,
		// whose nullable env models a whole-project posture).
		environment_id: uuid()
			.notNull()
			.references(() => projectEnvironments.id, { onDelete: "cascade" }),
		// True when the cluster's API server answered the liveness probe. An unreachable cluster is a
		// SUCCESSFUL probe with reachable=false (the honest "it's down" signal) — not a job failure.
		reachable: boolean().notNull(),
		// Short human-readable summary for the console badge, esp. WHY unreachable (kept out of the
		// jsonb so it's queryable without parsing). Never a secret.
		message: text(),
		// Honest structured probe result (endpoint, api-server status, node readiness, failure reason).
		// Mirrors the Go ProbeResult (packages/core/provisioner, built in B2.2).
		detail: jsonb().$type<ProbeDetail>().default({}),
		// When the probe actually ran (RFC3339, runner-supplied) — the timeline axis.
		probed_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
		// When the row was ingested by the console (server clock) — for GC/ordering when probed_at is absent.
		created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [
		// Read path: "latest probe for an env" + "recent probe history for an env" — newest first.
		index("idx_environment_probes_env_time").on(t.environment_id, t.probed_at.desc()),
	],
);

export type EnvironmentProbe = typeof environmentProbes.$inferSelect;
export type NewEnvironmentProbe = typeof environmentProbes.$inferInsert;
