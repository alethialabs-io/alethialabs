// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// What the changeset bar and the review view SAY (#6833), as pure functions over values.
//
// The path from "I changed the design" to "it is running" has three facts behind it — the draft's
// pending changes (the board), the saved design against the deployed one and the job in flight
// (`canvas.environmentStatus`), and the environment's latest plan (`canvas.reviewPlan`). Every
// sentence either surface shows is decided here from those facts, so the bar and the view cannot
// tell two stories, and each state has a test that does not need a browser.
//
// Nothing in this file enables a deploy. `deployBlock` can only ADD a reason to refuse one: the
// one thing that allows it is the store's `deployGate`, passed in as `gate`.

import type { StatusTier } from "@repo/ui/status-badge";
import type {
	ActiveJob,
	DeployRefusal,
	DeployState,
	EnvironmentJob,
	ReviewPlan,
} from "@/lib/canvas/component-status";
import type { DeployGate } from "@/lib/canvas/store/derive";
import type { PendingChange, ReviewedPlan, StagedOperation } from "@/lib/canvas/store/types";

/** Pluralises a count with its noun: "1 change", "3 changes". */
export function countOf(count: number, singular: string, plural = `${singular}s`): string {
	return `${count} ${count === 1 ? singular : plural}`;
}

/**
 * What kind of changes are pending, in words: "1 added · 2 edited · 1 removed · 1 add-on change".
 * Empty when nothing is pending.
 */
export function summarizeChanges(
	changes: readonly PendingChange[],
	operations: readonly StagedOperation[],
): string {
	const added = changes.filter((c) => c.op === "new").length;
	const edited = changes.filter((c) => c.op === "modified").length;
	const removed = changes.filter((c) => c.op === "removed").length;
	const parts: string[] = [];
	if (added > 0) parts.push(`${added} added`);
	if (edited > 0) parts.push(`${edited} edited`);
	if (removed > 0) parts.push(`${removed} removed`);
	if (operations.length > 0) parts.push(countOf(operations.length, "add-on change"));
	return parts.join(" · ");
}

/** What a job is doing, as the bar says it while the job runs. */
const JOB_RUNNING: Record<string, string> = {
	PLAN: "Planning",
	DEPLOY: "Deploying",
	DESTROY: "Destroying",
	AUDIT: "Auditing",
	DETECT_DRIFT: "Checking for drift",
	PROBE_CLUSTER: "Probing the cluster",
};

/** A job's name as a noun: "plan", "deploy". */
const JOB_NOUN: Record<string, string> = {
	PLAN: "plan",
	DEPLOY: "deploy",
	DESTROY: "destroy",
	AUDIT: "audit",
	DETECT_DRIFT: "drift check",
	PROBE_CLUSTER: "cluster probe",
};

/** The noun for a job type; "job" for one this file has no word for. */
export function jobNoun(type: string): string {
	return JOB_NOUN[type] ?? "job";
}

/**
 * True for a job no runner has started: it is queued, and it may be waiting for a runner or for an
 * approval. A claimed or processing job is running.
 */
export function isJobWaiting(status: string): boolean {
	return status === "QUEUED";
}

/**
 * Where a queued deploy is waiting, said once so the bar and the view use the same words. An
 * approval, where the organization asks for one, is valid for 60 minutes.
 */
export const DEPLOY_WAITING_EXPLANATION =
	"It starts when a runner picks it up. If your organization asks for an approval first, it waits for that: an approval can take up to 60 minutes. The job page shows what it is waiting on.";

/** The line for a job in flight: "Deploying", or "Deploy queued, waiting to start". */
export function activeJobLabel(job: Pick<ActiveJob, "type" | "status">): string {
	if (isJobWaiting(job.status)) {
		const noun = jobNoun(job.type);
		return `${noun.charAt(0).toUpperCase()}${noun.slice(1)} queued, waiting to start`;
	}
	return JOB_RUNNING[job.type] ?? "Running a job";
}

/** The bar's states. `pending` and `running` are about now; the other four are where things rest. */
export type BarKind = "pending" | "running" | "failed" | "never" | "ahead" | "in-sync";

/** What the bar shows. */
export interface BarState {
	kind: BarKind;
	/** The bar's sentence. */
	label: string;
	/** A second, quieter line of detail; null when there is none. */
	detail: string | null;
	/** The status dot's tier. State is the dot plus the words, never a hue. */
	tier: StatusTier;
	/** The job the state is about (running or failed), for "View log"; null otherwise. */
	jobId: string | null;
	/** True when "Review plan" is the bar's primary action; false when it is offered quietly. */
	reviewIsPrimary: boolean;
}

/** What {@link barState} decides from. */
export interface BarFacts {
	changes: readonly PendingChange[];
	operations: readonly StagedOperation[];
	deployState: DeployState;
	activeJob: ActiveJob | null;
	/** The environment's most recent settled job, newest first. */
	recentJobs: readonly EnvironmentJob[];
}

/**
 * The bar's state. Pending changes come first, because they are the person's own unsaved work and
 * Discard must stay reachable whatever else is happening; then a job in flight; then a failed last
 * deploy; then where the saved design stands against the deployed one.
 */
export function barState(facts: BarFacts): BarState {
	const pending = facts.changes.length + facts.operations.length;
	if (pending > 0) {
		return {
			kind: "pending",
			label: "Pending changes",
			detail: summarizeChanges(facts.changes, facts.operations),
			tier: "pending",
			jobId: null,
			reviewIsPrimary: true,
		};
	}
	if (facts.activeJob) {
		const waiting = isJobWaiting(facts.activeJob.status);
		return {
			kind: "running",
			label: activeJobLabel(facts.activeJob),
			detail: null,
			tier: waiting ? "pending" : "live",
			jobId: facts.activeJob.id,
			// A plan in flight is followed in the review view; any other job is followed in its log.
			reviewIsPrimary: facts.activeJob.type === "PLAN",
		};
	}
	const last = facts.recentJobs[0];
	if (last && last.type === "DEPLOY" && last.status === "FAILED") {
		return {
			kind: "failed",
			label: "Deploy failed",
			detail: "The log says why.",
			tier: "failed",
			jobId: last.id,
			reviewIsPrimary: true,
		};
	}
	switch (facts.deployState) {
		case "never":
			return {
				kind: "never",
				label: "Not deployed yet",
				detail: null,
				tier: "idle",
				jobId: null,
				reviewIsPrimary: true,
			};
		case "ahead":
			return {
				kind: "ahead",
				label: "Saved, not deployed",
				detail: null,
				tier: "pending",
				jobId: null,
				reviewIsPrimary: true,
			};
		case "in-sync":
			return {
				kind: "in-sync",
				label: "Up to date",
				detail: null,
				tier: "active",
				jobId: null,
				reviewIsPrimary: false,
			};
	}
}

/** Where the environment's latest plan job stands, as the review view shows it. */
export type PlanPhase =
	/** The read has not answered yet. */
	| "loading"
	/** The read failed. */
	| "unknown"
	/** The environment has no plan job. */
	| "none"
	/** The plan job is queued: no runner has started it. */
	| "waiting"
	/** A runner is computing the plan. */
	| "running"
	| "failed"
	| "cancelled"
	/** The plan succeeded and is the one to deploy. */
	| "current"
	/** The plan succeeded, and the design was saved after it. */
	| "design-changed"
	/** The plan succeeded, and a build, deploy or destroy was queued after it. */
	| "run-since";

/** The phase of the latest plan from the server's answer. */
export function planPhase(
	server: ReviewPlan | undefined,
	read: "loading" | "error" | "ready",
): PlanPhase {
	if (!server) return read === "error" ? "unknown" : "loading";
	if (server.planJobId === null || server.status === null) return "none";
	switch (server.status) {
		case "QUEUED":
			return "waiting";
		case "CLAIMED":
		case "PROCESSING":
			return "running";
		case "FAILED":
			return "failed";
		case "CANCELLED":
			return "cancelled";
		case "SUCCESS":
			break;
		default:
			return "unknown";
	}
	if (server.current) return "current";
	return server.staleReason === "run-since-plan" ? "run-since" : "design-changed";
}

/**
 * The `serverCurrent` to hand `usePlanReview`: true only when the server calls ITS latest plan
 * current AND that plan is the one the board recorded as reviewed. Anything else — no answer yet, a
 * failed read, a newer plan than the reviewed one, a plan still running — is false, so the board's
 * own record can never allow a deploy on its own.
 */
export function serverCurrentFor(
	server: ReviewPlan | undefined,
	reviewedPlan: ReviewedPlan | null,
): boolean {
	if (!server || !reviewedPlan) return false;
	return server.current && server.planJobId === reviewedPlan.planJobId;
}

/** What fixes a blocked action. `null` means there is nothing to press: the person waits. */
export type BlockFix =
	| "run-plan"
	| "use-plan"
	| "view-job"
	| "show-issues"
	| "retry-read"
	| "show-changes"
	| null;

/** Why Deploy is not available, in a sentence, with what fixes it. */
export interface DeployBlock {
	code:
		| "cloud-not-offered"
		| "issues"
		| "job-running"
		| "staged-operations"
		| "unsaved-edits"
		| "plan-loading"
		| "plan-unknown"
		| "no-plan"
		| "plan-waiting"
		| "plan-running"
		| "plan-failed"
		| "plan-cancelled"
		| "design-changed"
		| "run-since-plan"
		| "not-reviewed";
	/** The sentence shown beside the disabled button, and read out as its description. */
	reason: string;
	fix: BlockFix;
	/** The job `view-job` opens; null for every other fix. */
	jobId: string | null;
}

/** What {@link deployBlock} decides from. */
export interface DeployFacts {
	/** The store's gate (`usePlanReview(serverCurrent).gate`): the only thing that allows a deploy. */
	gate: DeployGate;
	refusal: DeployRefusal | null;
	activeJob: ActiveJob | null;
	/** Design changes pending against the saved design. */
	pendingDesign: number;
	/** Staged out-of-band operations. */
	pendingOperations: number;
	/** Validation issues in the draft. */
	issues: number;
	phase: PlanPhase;
	/**
	 * False while the server's answer is older than the saved design on the board: a save has been
	 * committed and the plan has not been read again since. An answer from before a save cannot
	 * say whether the plan is still the one to deploy.
	 */
	answerIsFresh: boolean;
	/** The latest plan job's id; null when there is none. */
	planJobId: string | null;
}

/**
 * Why Deploy is disabled, or null when it may be pressed. Null is returned ONLY when `gate.allowed`
 * is true; every other branch names one reason and the action that removes it. The order is the
 * order a person has to resolve them in.
 */
export function deployBlock(facts: DeployFacts): DeployBlock | null {
	if (facts.refusal) {
		return {
			code: "cloud-not-offered",
			reason: `${facts.refusal.message} This environment cannot be planned or deployed until its cloud account is on an available cloud.`,
			fix: null,
			jobId: null,
		};
	}
	if (facts.activeJob && facts.activeJob.type !== "PLAN") {
		const noun = jobNoun(facts.activeJob.type);
		return {
			code: "job-running",
			reason: isJobWaiting(facts.activeJob.status)
				? `A ${noun} is queued for this environment and has not started. Deploy again when it has finished.`
				: `A ${noun} is running on this environment. Deploy again when it has finished.`,
			fix: "view-job",
			jobId: facts.activeJob.id,
		};
	}
	if (facts.issues > 0) {
		return {
			code: "issues",
			reason: `The design has ${countOf(facts.issues, "issue")}. Fix ${facts.issues === 1 ? "it" : "them"} before planning.`,
			fix: "show-issues",
			jobId: null,
		};
	}
	if (facts.pendingDesign > 0) {
		return {
			code: "unsaved-edits",
			reason: `The design changed since the plan: ${countOf(facts.pendingDesign, "change")} not saved. Run plan saves the design and plans it.`,
			fix: "run-plan",
			jobId: null,
		};
	}
	if (facts.pendingOperations > 0) {
		return {
			code: "staged-operations",
			reason: `${countOf(facts.pendingOperations, "add-on change")} staged here cannot be applied from this view yet. Remove ${facts.pendingOperations === 1 ? "it" : "them"} from the list to deploy the design.`,
			fix: "show-changes",
			jobId: null,
		};
	}
	if (!facts.answerIsFresh) {
		return {
			code: "plan-loading",
			reason: "The design was just saved. Checking whether the plan is still the one to deploy.",
			fix: null,
			jobId: null,
		};
	}
	switch (facts.phase) {
		case "loading":
			return {
				code: "plan-loading",
				reason: "Checking for this environment's latest plan.",
				fix: null,
				jobId: null,
			};
		case "unknown":
			return {
				code: "plan-unknown",
				reason: "The latest plan could not be read, so there is nothing to deploy from.",
				fix: "retry-read",
				jobId: null,
			};
		case "none":
			return {
				code: "no-plan",
				reason: "No plan yet. A deploy applies a plan you have seen, so run one first.",
				fix: "run-plan",
				jobId: null,
			};
		case "waiting":
			return {
				code: "plan-waiting",
				reason: "The plan is queued and has not started. Deploy is available when it has finished.",
				fix: "view-job",
				jobId: facts.planJobId,
			};
		case "running":
			return {
				code: "plan-running",
				reason: "The plan is running. Deploy is available when it has finished.",
				fix: "view-job",
				jobId: facts.planJobId,
			};
		case "failed":
			return {
				code: "plan-failed",
				reason: "The plan failed, so there is nothing to deploy. Fix what it reports and run it again.",
				fix: "run-plan",
				jobId: facts.planJobId,
			};
		case "cancelled":
			return {
				code: "plan-cancelled",
				reason: "The plan was cancelled before it finished. Run it again.",
				fix: "run-plan",
				jobId: facts.planJobId,
			};
		case "design-changed":
			return {
				code: "design-changed",
				reason: "The design changed since the plan: it was saved after the plan ran. Run the plan again.",
				fix: "run-plan",
				jobId: null,
			};
		case "run-since":
			return {
				code: "run-since-plan",
				reason: "Something ran on this environment since the plan, so the plan no longer describes it. Run the plan again.",
				fix: "run-plan",
				jobId: null,
			};
		case "current":
			break;
	}
	if (!facts.gate.allowed) {
		return {
			code: "not-reviewed",
			reason: "This plan is current for the saved design, but it has not been confirmed in this session. Check what it lists, then choose Use this plan.",
			fix: "use-plan",
			jobId: null,
		};
	}
	return null;
}

/** Why Run plan is disabled, or null when it may be pressed. */
export function planBlock(facts: {
	refusal: DeployRefusal | null;
	activeJob: ActiveJob | null;
	issues: number;
}): { reason: string; jobId: string | null } | null {
	if (facts.refusal) return { reason: facts.refusal.message, jobId: null };
	if (facts.activeJob) {
		const noun = jobNoun(facts.activeJob.type);
		return {
			reason: `A ${noun} is ${isJobWaiting(facts.activeJob.status) ? "queued" : "running"} on this environment. Run the plan when it has finished.`,
			jobId: facts.activeJob.id,
		};
	}
	if (facts.issues > 0) {
		return {
			reason: `Fix the ${countOf(facts.issues, "issue")} listed above first: a design with issues cannot be saved.`,
			jobId: null,
		};
	}
	return null;
}

/** The plan's counts as one sentence: "3 to add · 1 to change · 0 to destroy". */
export function planCountsSentence(counts: NonNullable<ReviewPlan["summary"]>): string {
	const parts = [
		`${counts.create} to add`,
		`${counts.update} to change`,
		`${counts.delete} to destroy`,
	];
	if (counts.replace > 0) parts.push(`${counts.replace} to replace`);
	return parts.join(" · ");
}

/** How many resources a plan destroys or replaces: what a deploy of it cannot give back. */
export function destructiveCount(counts: ReviewPlan["summary"]): number {
	if (!counts) return 0;
	return counts.delete + counts.replace;
}

/** The longest a value is shown before it is cut. */
const VALUE_LIMIT = 80;

/**
 * A config value as the changes list shows it. An absent value reads "not set", a string is shown
 * as it is, and anything structured is its compact JSON, cut to a line.
 */
export function formatValue(value: unknown): string {
	if (value === undefined || value === null || value === "") return "not set";
	if (typeof value === "string") return clip(value);
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (Array.isArray(value) && value.length === 0) return "none";
	try {
		return clip(JSON.stringify(value));
	} catch {
		return "a value";
	}
}

/** `text` cut to {@link VALUE_LIMIT} characters, with an ellipsis when it was longer. */
function clip(text: string): string {
	return text.length > VALUE_LIMIT ? `${text.slice(0, VALUE_LIMIT - 1)}…` : text;
}

/** A config key as a label: `instance_class` reads "Instance class". */
export function fieldLabel(key: string): string {
	if (key === "cloud_identity_id") return "Cloud account";
	const words = key.replaceAll("_", " ").trim();
	if (words === "") return "Value";
	return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}
