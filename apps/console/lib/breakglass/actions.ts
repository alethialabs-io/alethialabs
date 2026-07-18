// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The break-glass DISPATCHER — the SINGLE choke point through which every privileged action runs.
// Every route funnels here, so the safety invariants are enforced in exactly one place and cannot be
// skipped by hitting an endpoint directly:
//
//   1. an active, operator-owned session must exist (else refuse),
//   2. the action's reason must be present + substantive,
//   3. a mutating action's exact resource id must be TYPED-CONFIRMED (server-side, not just UI),
//   4. a HIGH-blast action must CONSUME a valid two-person approval token (a different operator),
//   5. the "attempt" audit row is committed BEFORE the mutation (a failed act is still on record),
//   6. the mutation reuses the fencing-preserving primitives (never a raw state UPDATE),
//   7. a "result" audit row is appended after.
//
// Refusals are returned as a typed { ok:false } — the route maps them to 4xx. Only unexpected
// internal errors throw.

import { and, eq } from "drizzle-orm";
import { signedJob } from "@/lib/db/signed-job";
import type { BreakglassActionInput } from "@/types/jsonb.types";
import { getServiceDb } from "@/lib/db";
import { setEnvStatus } from "@/lib/db/env-status";
import type { BreakglassAction } from "@/lib/db/schema/enums";
import {
	jobs,
	projectEnvironments,
	projects,
	tofuStateLocks,
} from "@/lib/db/schema";
import { getStripe } from "@/lib/billing/stripe";
import { isStripeConfigured } from "@/lib/billing/config";
import {
	claimWebhookEvent,
	markWebhookEventDone,
	resetWebhookEvent,
} from "@/lib/billing/webhook-events";
import { handleStripeEvent } from "@/lib/billing/webhook-handler";
import { markRunnerDraining } from "@/lib/fleet/queue";
import { wakeFleetScaler } from "@/lib/fleet/scaler";
import { notifyRunnerCancel } from "@/lib/runners/cancel-signal";
import { forceReleaseStateLock } from "@/lib/runners/state-lock";
import { newTraceparent } from "@/lib/observability/trace";
import { log } from "@/lib/observability/log";
import { writeAttemptAudit, writeResultAudit } from "./audit";
import type { BreakglassOperator } from "./auth";
import { catalogSpec } from "./catalog";
import { isOrphanCleanArmed } from "./config";
import { consumeApproval } from "./approval";
import { getLiveSession } from "./session";

/** The vetted action command a route hands the dispatcher (already zod-parsed at the edge). */
export interface BreakglassCommand {
	sessionId: string;
	action: Exclude<BreakglassAction, "open_session">;
	resourceId?: string;
	/** Typed-confirm of the exact resource id — must equal resourceId for mutating actions. */
	confirm?: string;
	reason: string;
	approvalId?: string;
	input?: BreakglassActionInput;
}

export type BreakglassResult =
	| { ok: true; detail: string; data?: unknown }
	// A refusal — everything fail-closed. `code` maps to an HTTP status at the route.
	| { ok: false; code: number; message: string };

const MIN_REASON = 8;

/**
 * Runs a break-glass action end-to-end through the full gate. Returns a typed result; only truly
 * unexpected errors propagate (routes 500 them and the failure is on the "result" audit row).
 */
export async function executeBreakglassAction(
	operator: BreakglassOperator,
	cmd: BreakglassCommand,
): Promise<BreakglassResult> {
	const spec = catalogSpec(cmd.action);
	if (!spec) return refuse(400, `Unknown break-glass action: ${cmd.action}`);

	// (2) Reason gate.
	if (!cmd.reason || cmd.reason.trim().length < MIN_REASON) {
		return refuse(400, `A substantive reason (≥ ${MIN_REASON} chars) is required.`);
	}

	// (1) Active, operator-owned session.
	const session = await getLiveSession(cmd.sessionId, operator.email);
	if (!session) {
		return refuse(403, "No active break-glass session (open one first, or it expired).");
	}

	// (3) Typed-confirm of the exact resource id for mutating actions.
	if (spec.requiresResourceId) {
		if (!cmd.resourceId) return refuse(400, "resourceId is required for this action.");
		if (!spec.readOnly && cmd.confirm !== cmd.resourceId) {
			return refuse(
				400,
				"Typed-confirm mismatch: `confirm` must exactly equal the resource id.",
			);
		}
	}

	// (4) Two-person approval for HIGH-blast actions — consumed server-side (single-use, bound to
	// this exact action+resource+input, minted by a DIFFERENT operator). Not bypassable by calling
	// the endpoint directly: the dispatcher requires it here.
	let approverEmail: string | null = null;
	if (spec.requiresApproval) {
		if (!cmd.approvalId) {
			return refuse(403, "This high-blast action requires a two-person approval token.");
		}
		if (!cmd.resourceId) {
			return refuse(400, "resourceId is required to bind the approval.");
		}
		const consumed = await consumeApproval({
			approvalId: cmd.approvalId,
			actorEmail: operator.email,
			action: cmd.action,
			resourceType: resourceTypeFor(cmd.action),
			resourceId: cmd.resourceId,
		});
		if (!consumed.ok) {
			return refuse(403, `Two-person approval rejected: ${consumed.reason}.`);
		}
		approverEmail = consumed.approval.approver_email;
	}

	const auditBase = {
		sessionId: session.id,
		actorEmail: operator.email,
		action: cmd.action,
		blastRadius: spec.blastRadius,
		resourceType: resourceTypeFor(cmd.action),
		resourceId: cmd.resourceId ?? null,
		reason: cmd.reason,
		input: cmd.input,
		approverEmail,
		approvalId: cmd.approvalId ?? null,
	};

	// (5) Commit the attempt row BEFORE the mutation. If the action then fails, it is still recorded.
	await writeAttemptAudit(auditBase);

	try {
		// (6) The mutation — reusing the fencing-preserving primitives.
		const outcome = await runHandler(operator, cmd);
		if (!outcome.ok) {
			await writeResultAudit(auditBase, "error", outcome.message);
			return outcome;
		}
		await writeResultAudit(auditBase, "ok", outcome.detail);
		return outcome;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log.error("break-glass action threw", {
			action: cmd.action,
			actor: operator.email,
			resource_id: cmd.resourceId,
			error: message,
		});
		await writeResultAudit(auditBase, "error", message);
		return refuse(500, `Action failed: ${message}`);
	}
}

/** A coarse resource-type label per action (also the approval-binding key). */
export function resourceTypeFor(action: BreakglassAction): string {
	switch (action) {
		case "inspect_job":
		case "retry_job":
		case "cancel_job":
			return "job";
		case "unstick_env":
			return "environment";
		case "drain_runner":
		case "restart_runner":
			return "runner";
		case "replay_webhook":
			return "webhook";
		case "force_release_state_lock":
		case "state_surgery":
			return "state_lock";
		case "orphan_detect":
		case "orphan_clean":
			return "orphan";
		case "open_session":
			return "session";
	}
}

/** Dispatches to the concrete handler. Each reuses an existing fencing-preserving primitive. */
async function runHandler(
	operator: BreakglassOperator,
	cmd: BreakglassCommand,
): Promise<BreakglassResult> {
	switch (cmd.action) {
		case "inspect_job":
			return inspectJob(cmd.resourceId!);
		case "retry_job":
			return retryJob(cmd.resourceId!);
		case "cancel_job":
			return cancelJobBg(cmd.resourceId!);
		case "unstick_env":
			return unstickEnv(cmd.resourceId!, cmd.input);
		case "drain_runner":
			return drainRunner(cmd.resourceId!);
		case "restart_runner":
			return restartRunner(cmd.resourceId!);
		case "replay_webhook":
			return replayWebhook(cmd.resourceId!, cmd.input);
		case "force_release_state_lock":
			return forceReleaseLock(cmd.resourceId!);
		case "state_surgery":
			return enqueueStateSurgery(operator, cmd.resourceId!, cmd.input);
		case "orphan_detect":
			return orphanDetect(cmd.input);
		case "orphan_clean":
			return orphanClean();
	}
}

// ── Handlers (cross-tenant via getServiceDb — this is the RLS-bypassing surface) ──────────────────

/** inspect_job (blast: none) — read a job's full row for diagnosis. */
async function inspectJob(jobId: string): Promise<BreakglassResult> {
	const [job] = await getServiceDb().select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
	if (!job) return refuse(404, "Job not found.");
	return { ok: true, detail: `inspected job ${jobId} (status ${job.status})`, data: job };
}

/**
 * retry_job (blast: low) — re-enqueue a FRESH job from a stuck/failed one, mirroring rerunJob but
 * cross-tenant (carries the original's user/org/project so tenancy stays correct). The poison
 * counter starts fresh (a new row), matching the product rerun semantics.
 */
async function retryJob(jobId: string): Promise<BreakglassResult> {
	const db = getServiceDb();
	const [orig] = await db
		.select({
			user_id: jobs.user_id,
			org_id: jobs.org_id,
			job_type: jobs.job_type,
			config_snapshot: jobs.config_snapshot,
			cloud_identity_id: jobs.cloud_identity_id,
			project_id: jobs.project_id,
			environment_id: jobs.environment_id,
		})
		.from(jobs)
		.where(eq(jobs.id, jobId))
		.limit(1);
	if (!orig) return refuse(404, "Job not found.");

	const [created] = await db
		.insert(jobs)
		.values(signedJob({
			user_id: orig.user_id,
			org_id: orig.org_id,
			job_type: orig.job_type,
			config_snapshot: orig.config_snapshot,
			cloud_identity_id: orig.cloud_identity_id,
			project_id: orig.project_id,
			environment_id: orig.environment_id,
			status: "QUEUED",
			traceparent: newTraceparent(),
		}))
		.returning({ id: jobs.id });
	wakeFleetScaler();
	return { ok: true, detail: `re-enqueued as job ${created.id}`, data: { jobId: created.id } };
}

/**
 * cancel_job (blast: low) — flip to CANCELLED and, if running, signal the runner to stop mid-flight.
 * Reuses the exact cancelJob semantics (DB flip authoritative; fire-and-forget runner signal) but
 * cross-tenant. Never touches state directly — the runner does the clean SIGINT teardown.
 */
async function cancelJobBg(jobId: string): Promise<BreakglassResult> {
	const db = getServiceDb();
	const [job] = await db
		.select({ status: jobs.status, runner_id: jobs.runner_id })
		.from(jobs)
		.where(eq(jobs.id, jobId))
		.limit(1);
	if (!job) return refuse(404, "Job not found.");
	if (!["QUEUED", "CLAIMED", "PROCESSING"].includes(job.status)) {
		return refuse(400, `Cannot cancel a job in status ${job.status}.`);
	}
	await db
		.update(jobs)
		.set({
			status: "CANCELLED",
			error_message: "Cancelled by break-glass operator",
			completed_at: new Date(),
		})
		.where(eq(jobs.id, jobId));
	if (job.runner_id && (job.status === "CLAIMED" || job.status === "PROCESSING")) {
		await notifyRunnerCancel(job.runner_id, jobId).catch(() => {});
	}
	return { ok: true, detail: `cancelled job ${jobId} (was ${job.status})` };
}

/**
 * unstick_env (blast: medium) — move a stuck environment via the set_env_status CAS with an EXPLICIT
 * expected_from[] + target. NEVER a raw UPDATE: the CAS is the fencing-preserving primitive, so a
 * racing runner callback can't be clobbered. A CAS miss (env not in expected_from) is a fail-closed
 * refusal, not a silent overwrite.
 */
async function unstickEnv(
	envId: string,
	input: BreakglassActionInput | undefined,
): Promise<BreakglassResult> {
	const from = input?.expectedFrom ?? [];
	const to = input?.to;
	if (from.length === 0 || !to) {
		return refuse(400, "unstick_env requires input.expectedFrom[] and input.to.");
	}
	const moved = await setEnvStatus(getServiceDb(), envId, from, to, null, {
		context: "breakglassUnstick",
		silent: true,
	});
	if (!moved) {
		return refuse(
			409,
			`CAS rejected: env ${envId} was not in [${from.join(", ")}] (no change made).`,
		);
	}
	return { ok: true, detail: `env ${envId} moved [${from.join(",")}] → ${to}` };
}

/** drain_runner (blast: low) — flip an ONLINE runner to DRAINING so it stops claiming jobs. */
async function drainRunner(runnerId: string): Promise<BreakglassResult> {
	await markRunnerDraining(runnerId);
	return { ok: true, detail: `runner ${runnerId} set DRAINING` };
}

/**
 * restart_runner (blast: medium) — drain then wake the fleet scaler to roll a replacement. In the
 * immutable cattle model a "restart" is drain→replace, so this is drain + a convergence nudge.
 */
async function restartRunner(runnerId: string): Promise<BreakglassResult> {
	await markRunnerDraining(runnerId);
	wakeFleetScaler();
	return { ok: true, detail: `runner ${runnerId} draining; scaler woken to replace` };
}

/**
 * replay_webhook (blast: low) — re-dispatch a stored Stripe event through the EXACT same idempotent
 * handler the live webhook uses. The two NON-idempotent outward side effects — branded emails and the
 * invoice.payment_failed backup-card retry — are BOTH suppressed by default so a replay re-processes
 * STATE without re-mailing or re-charging a customer; an operator can explicitly opt either back in.
 * Resets the exactly-once guard first so an already-`done` event can be re-run, then re-claims + done.
 */
async function replayWebhook(
	eventId: string,
	input: BreakglassActionInput | undefined,
): Promise<BreakglassResult> {
	if (!isStripeConfigured()) return refuse(503, "Billing/Stripe is not configured.");
	const event = await getStripe().events.retrieve(eventId);
	const suppressEmails = input?.suppressEmails ?? true;
	const suppressPaymentRetry = input?.suppressPaymentRetry ?? true;
	await resetWebhookEvent(eventId);
	await claimWebhookEvent(event.id, event.type);
	await handleStripeEvent(event, { suppressEmails, suppressPaymentRetry });
	await markWebhookEventDone(event.id);
	const notes = [
		suppressEmails ? "emails suppressed" : null,
		suppressPaymentRetry ? "payment retry suppressed" : null,
	].filter(Boolean);
	return {
		ok: true,
		detail: `replayed ${event.type} ${event.id}${notes.length ? ` (${notes.join(", ")})` : ""}`,
	};
}

/**
 * force_release_state_lock (blast: HIGH, two-person) — force-release a stranded tofu state lock via
 * the primitive that ROTATES the fencing token + bumps generation (never a naive delete), so a
 * zombie writer is fenced out. Two-person + typed-confirm are enforced by the dispatcher above.
 */
async function forceReleaseLock(stateKey: string): Promise<BreakglassResult> {
	const existed = await forceReleaseStateLock(stateKey);
	return {
		ok: true,
		detail: existed
			? `force-released + fenced lock for ${stateKey}`
			: `no lock held for ${stateKey} (no-op)`,
	};
}

/**
 * state_surgery (blast: HIGH, two-person) — queue a PRIVILEGED STATE_SURGERY job through the NORMAL
 * runner/state pipeline (claim_next_job → tofu-state backend), so state fencing stays intact —
 * never a raw state UPDATE. The runner-side executor ships INERT (fail-closed): it refuses unless a
 * runner opts in via ALETHIA_BREAKGLASS_STATE_SURGERY_ENABLED, so this enqueue proves the audited,
 * two-person, fencing-preserving path WITHOUT ever mutating state through an unproven executor.
 */
async function enqueueStateSurgery(
	operator: BreakglassOperator,
	stateKey: string,
	input: BreakglassActionInput | undefined,
): Promise<BreakglassResult> {
	if (!operator.userId) {
		return refuse(403, "state_surgery requires an operator with an Alethia account id.");
	}
	// state_key = projects/{project_id}/{environment_id}/tofu.tfstate — parse for tenancy.
	const m = stateKey.match(/^projects\/([^/]+)\/([^/]+)\/tofu\.tfstate$/);
	if (!m) {
		return refuse(400, "state_surgery resourceId must be a projects/…/…/tofu.tfstate state key.");
	}
	const [, projectId, environmentId] = m;
	const db = getServiceDb();
	const [project] = await db
		.select({ id: projects.id, org_id: projects.org_id })
		.from(projects)
		.where(eq(projects.id, projectId))
		.limit(1);
	if (!project) return refuse(404, `Project ${projectId} not found for state key.`);

	const [created] = await db
		.insert(jobs)
		.values(signedJob({
			user_id: operator.userId,
			org_id: project.org_id,
			project_id: projectId,
			environment_id: environmentId,
			job_type: "STATE_SURGERY",
			config_snapshot: {
				state_key: stateKey,
				note: input?.surgeryNote ?? null,
				initiated_by: operator.email,
			},
			status: "QUEUED",
			traceparent: newTraceparent(),
		}))
		.returning({ id: jobs.id });
	wakeFleetScaler();
	return {
		ok: true,
		detail: `queued STATE_SURGERY job ${created.id} for ${stateKey} (runner executor is inert)`,
		data: { jobId: created.id },
	};
}

/**
 * orphan_detect (blast: none) — READ-ONLY, run-scoped detection. For a single project, report
 * environments that are DESTROYED yet still carry tofu-state-lock residue (a candidate orphan). It
 * is deliberately scoped to ONE project id (never account-wide) — see [[scope-destructive-cloud-ops]].
 */
async function orphanDetect(
	input: BreakglassActionInput | undefined,
): Promise<BreakglassResult> {
	const projectId = input?.projectId;
	if (!projectId) return refuse(400, "orphan_detect requires input.projectId (run-scoped).");
	const db = getServiceDb();
	const destroyedEnvs = await db
		.select({
			id: projectEnvironments.id,
			name: projectEnvironments.name,
			status: projectEnvironments.status,
		})
		.from(projectEnvironments)
		.where(
			and(
				eq(projectEnvironments.project_id, projectId),
				eq(projectEnvironments.status, "DESTROYED"),
			),
		);

	const candidates: Array<{ environmentId: string; name: string; stateKey: string }> = [];
	for (const env of destroyedEnvs) {
		const stateKey = `projects/${projectId}/${env.id}/tofu.tfstate`;
		const [lock] = await db
			.select({ state_key: tofuStateLocks.state_key })
			.from(tofuStateLocks)
			.where(eq(tofuStateLocks.state_key, stateKey))
			.limit(1);
		if (lock) candidates.push({ environmentId: env.id, name: env.name, stateKey });
	}
	return {
		ok: true,
		detail: `scanned project ${projectId}: ${candidates.length} orphan candidate(s)`,
		data: { projectId, candidates },
	};
}

/**
 * orphan_clean (blast: HIGH) — a cross-cloud force-destroy: the single most dangerous action. It
 * ships INERT (fail-closed). Even with a valid two-person approval it refuses unless separately
 * armed via ALETHIA_BREAKGLASS_ORPHAN_CLEAN_ENABLED, and even then returns "not implemented" rather
 * than performing an unscoped delete — a real cleaner must enqueue a RUN-SCOPED destroy (never an
 * account-wide delete-loop). Shipping it inert is the deliberate fail-closed choice.
 */
async function orphanClean(): Promise<BreakglassResult> {
	if (!isOrphanCleanArmed()) {
		return refuse(
			403,
			"orphan_clean is INERT (fail-closed): set ALETHIA_BREAKGLASS_ORPHAN_CLEAN_ENABLED to arm it.",
		);
	}
	return refuse(
		501,
		"orphan_clean executor is not implemented — it must enqueue a run-scoped destroy, never an account-wide delete. Refusing.",
	);
}

/** Builds a typed refusal. */
function refuse(code: number, message: string): BreakglassResult {
	return { ok: false, code, message };
}
