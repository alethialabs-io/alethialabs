// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Guarded env-status transitions (compare-and-swap). project_environments.status used to be
// written with bare `db.update(...).set({ status })` from several racing places (the runner
// status callback, finalizeDeployment, maybeAutoHeal, the enqueue actions). With no precondition,
// a late DEPLOY-SUCCESS arriving after a DESTROY had already moved an env to DESTROYED silently
// clobbered DESTROYED→ACTIVE (last-writer-wins state corruption).
//
// Every status write now routes through `setEnvStatus` / `transitionEnv`, which call the
// `set_env_status` CAS RPC (programmables.sql): a single indexed UPDATE gated on the current
// status ∈ expected_from[]. The RPC returns whether a row moved; FALSE means the env wasn't in a
// legal from-state, so the transition was correctly rejected. On a rejection we log + alert and
// (for runner callbacks) DO NOT throw — a lost race must never fail a status callback.
//
// NB (B2c backstop, separate task): a *dropped-but-legal* update (the transition table below being
// too narrow) would leave job=SUCCESS / env=stale. The log + `system.project.status_conflict`
// alert here make that drift visible; a reconciler that converges env-status to the latest terminal
// job is the backstop and is intentionally NOT built here.

import { sql } from "drizzle-orm";
import type { Db, Tx } from "@/lib/db";
import type { ProjectStatus } from "@/lib/db/schema/enums";
import { emitAlertEventSafe } from "@/lib/alerts/emit";
import { log } from "@/lib/observability/log";

/** Either the RLS-bypassing service Db or an owner-scoped transaction — both expose `execute`. */
export type EnvStatusDb = Pick<Db, "execute"> | Pick<Tx, "execute">;

/** A legal env-status transition: the set of statuses it may move FROM, and the status it moves TO. */
export interface EnvTransition {
	from: ProjectStatus[];
	to: ProjectStatus;
}

/**
 * The legal env-status transition table, keyed by the flow context that drives it. Derived from the
 * real (job_type × job_status × current_env_status) flows in the codebase — the single source of
 * truth for the `expected_from[]` every caller passes, so the state machine is documented + testable.
 *
 * Runner-callback contexts (deploy/plan/destroy lifecycle) fire from the job-status route as a job
 * moves PROCESSING → SUCCESS/FAILED. Enqueue contexts fire from the user-driven server actions in
 * projects.ts / reconcile.ts as a new job is queued.
 */
export const ENV_TRANSITIONS = {
	// ── Enqueue (user-driven server actions; a new job is queued → env QUEUED). Excludes the
	// in-flight states (QUEUED/PROVISIONING/DESTROYING) so a double-enqueue is rejected.
	enqueuePlan: { from: ["DRAFT", "ACTIVE", "FAILED", "DESTROYED"], to: "QUEUED" },
	enqueueDeploy: { from: ["DRAFT", "ACTIVE", "FAILED", "DESTROYED"], to: "QUEUED" },
	// Destroy is a teardown — allow it from any non-terminal-destroyed live state (incl. a
	// half-provisioned PROVISIONING env), but not from an already-DESTROYED one.
	enqueueDestroy: { from: ["DRAFT", "ACTIVE", "FAILED", "PROVISIONING"], to: "QUEUED" },
	// Auto-heal re-applies the last-deployed design; only ever off a settled (non-in-flight) env.
	enqueueAutoHeal: { from: ["ACTIVE", "FAILED", "DRAFT"], to: "QUEUED" },

	// ── DEPLOY lifecycle (runner callbacks).
	deployStart: { from: ["QUEUED", "PROVISIONING"], to: "PROVISIONING" },
	deploySuccess: { from: ["PROVISIONING", "QUEUED"], to: "ACTIVE" },
	deployFailed: { from: ["QUEUED", "PROVISIONING"], to: "FAILED" },

	// ── PLAN lifecycle (runner callbacks). A plan moves the env back to DRAFT on success (it
	// re-computes the design without applying); it never leaves QUEUED via a PROCESSING callback.
	planSuccess: { from: ["QUEUED", "PROVISIONING"], to: "DRAFT" },
	planFailed: { from: ["QUEUED", "PROVISIONING"], to: "FAILED" },

	// ── DESTROY lifecycle (runner callbacks).
	// ACTIVE is in the from-set to close the destroy-vs-provision race tail: if a straggler
	// DEPLOY-SUCCESS resurrects an env to ACTIVE (its QUEUED state let deploySuccess win) while a
	// DESTROY job for it is already in flight, the destroy's PROCESSING callback must still be able to
	// drive ACTIVE→DESTROYING — otherwise the destroy tears down the infra but leaves the env stuck
	// ACTIVE with nothing behind it. A destroyStart only ever fires for an env whose DESTROY was
	// enqueued, so accepting ACTIVE here can't clobber an unrelated live env.
	destroyStart: { from: ["QUEUED", "PROVISIONING", "ACTIVE"], to: "DESTROYING" },
	// The clobber fix: DESTROYED is NOT in any deploy*/plan* from-set, so a late DEPLOY-SUCCESS
	// (deploySuccess: PROVISIONING|QUEUED → ACTIVE) can never move a DESTROYED env back to ACTIVE.
	destroySuccess: { from: ["DESTROYING", "QUEUED"], to: "DESTROYED" },
	destroyFailed: { from: ["QUEUED", "DESTROYING"], to: "FAILED" },
} satisfies Record<string, EnvTransition>;

/** A key of the transition table — the flow context a caller passes to `transitionEnv`. */
export type EnvTransitionContext = keyof typeof ENV_TRANSITIONS;

/** Extra context for the structured log + conflict alert emitted when a transition is rejected. */
export interface EnvStatusMeta {
	/** The flow context (transition-table key), for the log/alert. */
	context?: EnvTransitionContext | string;
	/** Org that owns the env — required to fan out the `system.project.status_conflict` alert. */
	orgId?: string | null;
	projectId?: string | null;
	/**
	 * Suppress the warn + `system.project.status_conflict` alert on a rejected CAS. For callers
	 * where a lost race is EXPECTED and benign — the env-status convergence backstop
	 * (lib/reconcile/converge.ts) speculatively CASes many envs each tick and treats a rejection as
	 * "already settled / not mine", so it must not alert-storm. User-driven + runner-callback
	 * transitions leave this off so genuine conflicts stay visible.
	 */
	silent?: boolean;
}

/**
 * Compare-and-swap an environment's status: move it to `to` only if its current status is one of
 * `from`. Returns whether a row actually moved. On a rejection (FALSE — the env wasn't in a legal
 * from-state, i.e. a lost race) it emits a structured warn + a `system.project.status_conflict`
 * alert and returns FALSE; it never throws, so a runner status callback can't fail on a lost race.
 * The caller decides what a FALSE means for it (a user-facing enqueue may choose to roll back).
 */
export async function setEnvStatus(
	db: EnvStatusDb,
	envId: string,
	from: ProjectStatus[],
	to: ProjectStatus,
	jobId: string | null,
	meta?: EnvStatusMeta,
): Promise<boolean> {
	// Bind the from-set as a single Postgres array-literal string, NOT a raw JS array. Drizzle's
	// sql`` expands an interpolated JS array into a ($1, $2, …) parameter LIST (a record), and
	// `(rec)::text[]` is an illegal cast (42846: cannot cast type record to text[]) — so the CAS
	// failed against real Postgres even though the mocked unit tests passed. A `'{A,B}'::text[]`
	// literal binds as one text param and casts cleanly. ProjectStatus values are fixed uppercase
	// enum tokens (no commas/quotes/backslashes), so the brace-join needs no escaping.
	const fromArray = `{${from.join(",")}}`;
	const rows = await db.execute<{ updated: boolean }>(
		sql`select public.set_env_status(${envId}::uuid, ${fromArray}::text[], ${to}::text, ${jobId}::uuid) as updated`,
	);
	const updated = Boolean(rows[0]?.updated);

	if (!updated && !meta?.silent) {
		log.warn("env-status transition rejected (CAS lost race)", {
			job_id: jobId ?? undefined,
			org_id: meta?.orgId ?? undefined,
			env_id: envId,
			project_id: meta?.projectId ?? undefined,
			context: meta?.context,
			expected_from: from,
			attempted_to: to,
		});
		if (meta?.orgId) {
			emitAlertEventSafe(meta.orgId, "system.project.status_conflict", {
				title: "Environment status conflict",
				summary: `Rejected ${meta?.context ?? "transition"} → ${to}: env was not in [${from.join(", ")}]`,
				severity: "warning",
				resource_type: "project",
				resource_id: envId,
				project_id: meta?.projectId ?? undefined,
				job_id: jobId ?? undefined,
			});
		}
	}
	return updated;
}

/**
 * Applies a named transition from `ENV_TRANSITIONS` — the preferred entry point, so callers pass a
 * flow context (e.g. "deploySuccess") instead of an ad-hoc from-set. Returns whether the env moved.
 */
export async function transitionEnv(
	db: EnvStatusDb,
	envId: string,
	context: EnvTransitionContext,
	jobId: string | null,
	meta?: Omit<EnvStatusMeta, "context">,
): Promise<boolean> {
	const t = ENV_TRANSITIONS[context];
	return setEnvStatus(db, envId, t.from, t.to, jobId, { ...meta, context });
}
