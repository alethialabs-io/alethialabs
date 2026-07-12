// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The break-glass action catalog — the single source of truth for each action's blast radius and
// its safety requirements (typed-confirm, two-person approval, inert-until-armed). The dispatcher
// (actions.ts) reads THIS to decide what to enforce, so the safety posture of every action is
// declared in one legible place and cannot drift per call site.

import type { BreakglassAction, BreakglassBlastRadius } from "@/lib/db/schema/enums";

/** Whether an action mutates anything (a read is exempt from the typed-confirm requirement). */
export interface BreakglassActionSpec {
	blastRadius: BreakglassBlastRadius;
	/** True for read-only actions (inspect / detect) — no typed-confirm, no mutation, no approval. */
	readOnly: boolean;
	/** Whether a valid two-person approval token is REQUIRED (enforced server-side). */
	requiresApproval: boolean;
	/** Whether a resource id is required + must be typed-confirmed exactly. */
	requiresResourceId: boolean;
	/** A one-line human description for the audit + CLI help. */
	description: string;
	/**
	 * INERT: the action is defined + fully gated, but its mutating executor is intentionally not
	 * wired (fail-closed) or is armed by a second independent flag. The dispatcher refuses it
	 * (unless separately armed) rather than exposing an ungated privileged mutation.
	 */
	inert?: boolean;
}

/**
 * Every break-glass action, keyed by its enum value. HIGH blast-radius ⇒ requiresApproval.
 * `open_session` is not here (it's the session-open path, not an action dispatched via execute).
 */
export const BREAKGLASS_CATALOG: Record<
	Exclude<BreakglassAction, "open_session">,
	BreakglassActionSpec
> = {
	inspect_job: {
		blastRadius: "none",
		readOnly: true,
		requiresApproval: false,
		requiresResourceId: true,
		description: "Read a job's full row cross-tenant (diagnosis).",
	},
	retry_job: {
		blastRadius: "low",
		readOnly: false,
		requiresApproval: false,
		requiresResourceId: true,
		description:
			"Re-enqueue a fresh job from a stuck/failed one (poison counter resets).",
	},
	cancel_job: {
		blastRadius: "low",
		readOnly: false,
		requiresApproval: false,
		requiresResourceId: true,
		description:
			"Cancel a queued/claimed/processing job and signal its runner to stop mid-flight.",
	},
	unstick_env: {
		blastRadius: "medium",
		readOnly: false,
		requiresApproval: false,
		requiresResourceId: true,
		description:
			"Move an environment out of a stuck status via the set_env_status CAS (explicit from→to).",
	},
	drain_runner: {
		blastRadius: "low",
		readOnly: false,
		requiresApproval: false,
		requiresResourceId: true,
		description: "Mark an ONLINE runner DRAINING so it stops claiming jobs.",
	},
	restart_runner: {
		blastRadius: "medium",
		readOnly: false,
		requiresApproval: false,
		requiresResourceId: true,
		description:
			"Drain a runner and wake the fleet scaler to roll a replacement (drain→replace).",
	},
	replay_webhook: {
		blastRadius: "low",
		readOnly: false,
		requiresApproval: false,
		requiresResourceId: true,
		description:
			"Re-dispatch a stored Stripe webhook event idempotently (emails suppressed by default).",
	},
	force_release_state_lock: {
		blastRadius: "high",
		readOnly: false,
		requiresApproval: true,
		requiresResourceId: true,
		description:
			"Force-release a stranded tofu state lock — rotates the fence + bumps generation (never a naive delete).",
	},
	state_surgery: {
		blastRadius: "high",
		readOnly: false,
		requiresApproval: true,
		requiresResourceId: true,
		// Enqueue path is real (audited + two-person); the RUNNER executor ships inert (fail-closed).
		inert: true,
		description:
			"Queue a privileged STATE_SURGERY job through the normal runner/state pipeline (executor inert).",
	},
	orphan_detect: {
		blastRadius: "none",
		readOnly: true,
		requiresApproval: false,
		requiresResourceId: false,
		description:
			"List cached cloud resources for a run scope whose environment is gone/destroyed (read-only).",
	},
	orphan_clean: {
		blastRadius: "high",
		readOnly: false,
		requiresApproval: true,
		requiresResourceId: false,
		// Cross-cloud force-destroy — the most dangerous action. Inert unless separately armed.
		inert: true,
		description:
			"Force-destroy detected orphans for a run scope (INERT: armed only via a second flag).",
	},
};

/** Look up a catalog spec, or null for an unknown/`open_session` action. */
export function catalogSpec(
	action: BreakglassAction,
): BreakglassActionSpec | null {
	if (action === "open_session") return null;
	return BREAKGLASS_CATALOG[action] ?? null;
}
