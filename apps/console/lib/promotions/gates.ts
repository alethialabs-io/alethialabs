// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Pure protection-gate evaluator for environment promotions. Given a target env's rules and the
// context assembled after its candidate PLAN (predecessor state, verify outcome, cost delta,
// approvals), it returns a per-rule verdict + an overall decision. No DB, no I/O — unit-testable.
// The orchestrator (app/server/actions/promotions.ts) builds the context and acts on the result.

import type {
	ApproverSpec,
	ClassificationEnforcement,
	GateEvaluation,
	GateResult,
} from "@/types/jsonb.types";

/** The toggleable rule set for one environment (subset of environment_protection_rules columns). */
export interface PromotionRules {
	require_predecessor: boolean;
	require_verify_pass: boolean;
	require_approval: boolean;
	/** Minutes since the predecessor deploy before promote may proceed; null = off. */
	soak_minutes: number | null;
	/** Cost delta (USD/mo) above which approval is required; null = off. */
	cost_delta_threshold: number | null;
}

/** The predecessor stage's deployment state, or null when the target has no lower stage. */
export interface PredecessorState {
	exists: boolean;
	/** Hash of the config the predecessor last successfully deployed. */
	deployedHash: string | null;
	/** Latest drift posture — true when the predecessor's live infra matches its state. */
	inSync: boolean;
	lastDeployedAt: Date | null;
}

/** An assigned classification value that imposes promotion gates (its label + policy). */
export interface EnforcingValue {
	value_label: string;
	dimension_label: string;
	enforcement: ClassificationEnforcement;
}

/** Value labels that forced a gate on via classification, per gate — for the gate detail's "why". */
export interface EnforcedReasons {
	manual_approval?: string[];
	verify_pass?: string[];
}

/** Everything the evaluator needs, assembled after the candidate PLAN completes. */
export interface GateContext {
	rules: PromotionRules;
	/** Fingerprint of the candidate config_snapshot being promoted. */
	candidateHash: string;
	predecessor: PredecessorState | null;
	/** Count of elench hard-control failures NOT waived by an authorized override; null = no report. */
	verifyUnwaivedHardFailures: number | null;
	/** Candidate plan cost minus the target's last-deployed cost (USD/mo); null = unknown. */
	costDelta: number | null;
	approvals: { approved: number; required: number };
	/** Classification values that forced approval/verify on — annotates those gates' detail. */
	enforcedReasons?: EnforcedReasons;
	/** Evaluation clock (ms since epoch) — injected so the evaluator stays pure/deterministic. */
	nowMs: number;
}

/**
 * Folds a target env's enforcing classification values into its raw protection rules (label drives
 * policy): OR-s the approval/verify gates on and lifts the required-approval count to the strictest
 * of the env's own `min_count` and every enforcing value's `min_approvals`. Returns the effective
 * rules, the effective minimum approvals (0 when approval isn't required), and the value labels
 * driving each gate (for the "why"). Pure — the orchestrator loads `enforcing` and calls this.
 */
export function applyClassificationEnforcement(
	raw: PromotionRules,
	spec: ApproverSpec | null,
	enforcing: EnforcingValue[],
): { rules: PromotionRules; minApprovals: number; reasons: EnforcedReasons } {
	const approvalLabels: string[] = [];
	const verifyLabels: string[] = [];
	let enforcedMin = 0;
	let requireApproval = raw.require_approval;
	let requireVerify = raw.require_verify_pass;

	for (const e of enforcing) {
		if (e.enforcement.require_approval) {
			requireApproval = true;
			approvalLabels.push(e.value_label);
			enforcedMin = Math.max(enforcedMin, e.enforcement.min_approvals);
		}
		if (e.enforcement.require_verify_pass) {
			requireVerify = true;
			verifyLabels.push(e.value_label);
		}
	}

	const baseMin = spec?.min_count ?? 1;
	const minApprovals = requireApproval ? Math.max(baseMin, enforcedMin, 1) : 0;

	const reasons: EnforcedReasons = {};
	if (approvalLabels.length > 0) reasons.manual_approval = approvalLabels;
	if (verifyLabels.length > 0) reasons.verify_pass = verifyLabels;

	return {
		rules: { ...raw, require_approval: requireApproval, require_verify_pass: requireVerify },
		minApprovals,
		reasons,
	};
}

/** Appends a "required because target is classified …" clause when classification forced the gate. */
function reasonSuffix(labels: string[] | undefined): string {
	return labels && labels.length > 0
		? ` — required because target is classified ${labels.join(", ")}`
		: "";
}

/** Evaluates every gate and folds them into an overall decision. */
export function evaluateGates(ctx: GateContext): GateEvaluation {
	const results: GateResult[] = [
		predecessorGate(ctx),
		verifyGate(ctx),
		soakGate(ctx),
		costGate(ctx),
		approvalGate(ctx),
	];

	// Any hard failure blocks; else any pending needs a human; else it passes.
	const overall = results.some((r) => r.status === "fail")
		? "blocked"
		: results.some((r) => r.status === "pending")
			? "pending_approval"
			: "pass";

	return { overall, results, evaluated_at: new Date(ctx.nowMs).toISOString() };
}

/** The predecessor stage must have deployed THIS design and be in sync. */
function predecessorGate(ctx: GateContext): GateResult {
	const type = "predecessor_healthy" as const;
	if (!ctx.rules.require_predecessor)
		return { type, status: "skipped", detail: "Predecessor check off" };
	if (!ctx.predecessor || !ctx.predecessor.exists)
		return { type, status: "fail", detail: "No predecessor environment to validate against" };
	if (!ctx.predecessor.inSync)
		return { type, status: "fail", detail: "Predecessor has drifted from its deployed state" };
	if (ctx.predecessor.deployedHash !== ctx.candidateHash)
		return {
			type,
			status: "fail",
			detail: "Predecessor hasn't deployed this design yet",
		};
	return { type, status: "pass", detail: "Predecessor deployed this design and is in sync" };
}

/** The plan's elench verify report must have no unwaived hard control failures. */
function verifyGate(ctx: GateContext): GateResult {
	const type = "verify_pass" as const;
	if (!ctx.rules.require_verify_pass)
		return { type, status: "skipped", detail: "Verify gate off" };
	const why = reasonSuffix(ctx.enforcedReasons?.verify_pass);
	if (ctx.verifyUnwaivedHardFailures === null)
		return { type, status: "pending", detail: `Awaiting plan verification report${why}` };
	if (ctx.verifyUnwaivedHardFailures > 0)
		return {
			type,
			status: "fail",
			detail: `${ctx.verifyUnwaivedHardFailures} unwaived hard control failure(s)${why}`,
		};
	return { type, status: "pass", detail: `No unwaived hard control failures${why}` };
}

/** A soak/bake timer since the predecessor deploy. */
function soakGate(ctx: GateContext): GateResult {
	const type = "soak_timer" as const;
	const mins = ctx.rules.soak_minutes;
	if (mins === null) return { type, status: "skipped", detail: "Soak timer off" };
	if (!ctx.predecessor || !ctx.predecessor.lastDeployedAt)
		return { type, status: "fail", detail: "No predecessor deploy to soak from" };
	const elapsedMin = (ctx.nowMs - ctx.predecessor.lastDeployedAt.getTime()) / 60_000;
	if (elapsedMin < mins)
		return {
			type,
			status: "pending",
			detail: `Soaking: ${Math.floor(elapsedMin)}/${mins} min since predecessor deploy`,
		};
	return { type, status: "pass", detail: `Soaked ${mins}+ min` };
}

/** A cost-delta threshold above which approval is required. */
function costGate(ctx: GateContext): GateResult {
	const type = "cost_delta" as const;
	const threshold = ctx.rules.cost_delta_threshold;
	if (threshold === null) return { type, status: "skipped", detail: "Cost gate off" };
	if (ctx.costDelta === null)
		return { type, status: "skipped", detail: "No prior cost to compare" };
	if (ctx.costDelta > threshold)
		return {
			type,
			status: "pending",
			detail: `Cost +$${ctx.costDelta.toFixed(2)}/mo exceeds $${threshold.toFixed(2)} — needs approval`,
		};
	return { type, status: "pass", detail: `Cost delta within $${threshold.toFixed(2)}/mo` };
}

/** A required number of manual approvals. */
function approvalGate(ctx: GateContext): GateResult {
	const type = "manual_approval" as const;
	if (!ctx.rules.require_approval)
		return { type, status: "skipped", detail: "Manual approval off" };
	const why = reasonSuffix(ctx.enforcedReasons?.manual_approval);
	if (ctx.approvals.approved < ctx.approvals.required)
		return {
			type,
			status: "pending",
			detail: `${ctx.approvals.approved}/${ctx.approvals.required} approvals${why}`,
		};
	return { type, status: "pass", detail: `Approved${why}` };
}
