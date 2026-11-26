// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Plan-bound apply on the console side (agent surface S0, decision M23): a DEPLOY that a person or a
// credential asks for applies a reviewed plan, and that plan only.
//
// Three things are stamped on the job rows so the runner can hold the apply to the reviewed plan:
//
// - a PLAN job carries `configuration_hash` (the hash of the config snapshot it was planned from) and,
//   once it succeeds, `plan_sha256` (the digest its verify receipt records);
// - a DEPLOY that names a plan carries `plan_job_id`, `plan_sha256` copied from that plan, and its own
//   `configuration_hash`, which equals the plan's whenever the plan is current;
// - a DEPLOY with no plan exists only on the system origins that re-apply something already decided
//   (auto-heal re-applies the last deployed snapshot, the build chain deploys the snapshot its BUILD
//   was queued with). They keep `initiated_by = 'system'` and no `plan_job_id`, and the runner plans
//   them afresh.
//
// The runner refuses a DEPLOY that names a plan without carrying a matching digest
// (apps/runner/internal/agent/plan_binding.go), so the stamp below is what lets the apply run.
//
// A DESTROY is bound by the same three stamps (#7455), to a destroy-mode plan: a PLAN job queued with
// `destroy_plan`, which ran `tofu plan -destroy` and stored that plan as its artifact. A destroy plan
// has no verify receipt, so its `plan_sha256` is stamped from the digest the runner records for the
// stored file (`execution_metadata.plan_file_sha256`, {@link destroyPlanFileDigest}). The DESTROY that
// consumes a person's approval is stamped with the approved plan's id and digest (gate.ts), and the
// runner tears down exactly that saved plan. The mode is part of the binding both ways: a DEPLOY
// never names a destroy plan here, a destroy approval never names anything else (request.ts), and
// the runner checks both again.

import { createHash } from "node:crypto";
import { and, eq, gt, inArray } from "drizzle-orm";
import { z } from "zod";
import { type PlanStaleReason, planStaleReason } from "@/lib/canvas/component-status";
import type { Tx } from "@/lib/db";
import { jobs } from "@/lib/db/schema";
import { canonicalJson } from "@/lib/runners/snapshot-sig";
import type { ExecutionMetadata } from "@/types/jsonb.types";

/** A SHA-256 digest as the jobs and apply_approvals tables store it: 64 lowercase hex characters. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** The job types whose queueing after a plan makes that plan no longer the one to apply. */
const RUN_JOB_TYPES = ["BUILD", "DEPLOY", "DESTROY"] as const;

/**
 * The hash of a config snapshot that `jobs.configuration_hash` holds: SHA-256 over the canonical JSON
 * (recursively sorted keys), so the value is the same for the in-memory snapshot at insert and for the
 * jsonb read-back, whatever key order Postgres stores.
 */
export function configurationHashOf(snapshot: unknown): string {
	return createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
}

/** The fields of a PLAN job row {@link planDigestOf} reads. */
export interface PlanDigestSource {
	plan_sha256: string | null;
	execution_metadata: ExecutionMetadata | null;
}

/**
 * The digest of the plan file a PLAN job produced, lowercase hex: the `plan_sha256` column when it is
 * stamped, else the value its verify receipt records. Null when neither holds a SHA-256 digest.
 */
export function planDigestOf(plan: PlanDigestSource): string | null {
	const stamped = plan.plan_sha256?.trim().toLowerCase();
	if (stamped && SHA256_HEX.test(stamped)) return stamped;
	return receiptPlanDigest(plan.execution_metadata);
}

/** The plan digest a job's verify receipt records, lowercase hex, or null when it holds none. */
export function receiptPlanDigest(metadata: ExecutionMetadata | null | undefined): string | null {
	const fromReceipt = metadata?.verify_receipt?.receipt?.plan_sha256?.trim().toLowerCase();
	return fromReceipt && SHA256_HEX.test(fromReceipt) ? fromReceipt : null;
}

/**
 * The digest a destroy-mode PLAN job's runner recorded for the plan file it stored, lowercase hex, or
 * null when it recorded none. What the status route stamps on a succeeded destroy plan's `plan_sha256`.
 */
export function destroyPlanFileDigest(metadata: ExecutionMetadata | null | undefined): string | null {
	const digest = metadata?.plan_file_sha256?.trim().toLowerCase();
	return digest && SHA256_HEX.test(digest) ? digest : null;
}

/** Why an apply was not queued against a reviewed plan. Stable: the jobs API returns it as `code`. */
export type PlanBindingRefusalCode =
	| "plan_required"
	| "plan_not_found"
	| "plan_not_current"
	| "plan_digest_missing"
	| "plan_is_destroy_plan";

/**
 * A deploy that could not be tied to a current reviewed plan. Every message says what to do next, so
 * the console shows it as written and the jobs API returns it as the error.
 */
export class PlanBindingError extends Error {
	/** Builds the refusal; `message` is shown to the person who asked for the deploy. */
	constructor(
		readonly code: PlanBindingRefusalCode,
		message: string,
	) {
		super(message);
		this.name = "PlanBindingError";
	}
}

/** What a deploy is aimed at, and the configuration it would apply now. */
export interface ReviewedPlanTarget {
	projectId: string;
	environmentId: string;
	/** The plan the caller names; absent when it named none. */
	planJobId: string | null | undefined;
	/** {@link configurationHashOf} the config snapshot built for this deploy. */
	configurationHash: string;
}

/** The reviewed plan a deploy applies: what the DEPLOY row is stamped with. */
export interface ReviewedPlan {
	planJobId: string;
	planSha256: string;
}

/** The sentence for each way a named plan can be out of date. */
function staleMessage(reason: Exclude<PlanStaleReason, "no-plan">, planJobId: string, status: string): string {
	switch (reason) {
		case "plan-not-succeeded":
			return `Plan ${planJobId} has not succeeded (status ${status}). Wait for it to finish, or plan again, then apply.`;
		case "design-changed":
			return `The environment's configuration changed after plan ${planJobId} was made. Plan again, review the new plan, then apply it.`;
		case "run-since-plan":
			return `A build, deploy or destroy of this environment was queued after plan ${planJobId}. Plan again, review the new plan, then apply it.`;
	}
}

/**
 * The reviewed plan a deploy of `target` applies, or a {@link PlanBindingError} saying why there is
 * none. Read in `tx`, the transaction that then inserts the DEPLOY.
 *
 * The named plan must be a PLAN job of the same project and environment that plans an apply (a
 * destroy plan is refused with `plan_is_destroy_plan`), and current by the board's
 * own rule ({@link planStaleReason}): it succeeded, it was planned from the configuration the deploy
 * would apply now (its `configuration_hash` equals `target.configurationHash`), and no build, deploy or
 * destroy of the environment was queued after it. It must also carry a plan digest, which the runner
 * checks the downloaded plan file against.
 */
export async function resolveReviewedPlan(tx: Tx, target: ReviewedPlanTarget): Promise<ReviewedPlan> {
	const named = target.planJobId?.trim();
	if (!named) {
		throw new PlanBindingError(
			"plan_required",
			"A deploy applies a reviewed plan. Plan this environment, review the plan, then apply it.",
		);
	}
	if (!z.uuid().safeParse(named).success) {
		throw new PlanBindingError("plan_not_found", "The plan to apply is not a job id. Plan this environment, then apply that plan.");
	}
	const [plan] = await tx
		.select({
			id: jobs.id,
			status: jobs.status,
			configuration_hash: jobs.configuration_hash,
			plan_sha256: jobs.plan_sha256,
			execution_metadata: jobs.execution_metadata,
			destroy_plan: jobs.destroy_plan,
			created_at: jobs.created_at,
		})
		.from(jobs)
		.where(
			and(
				eq(jobs.id, named),
				eq(jobs.job_type, "PLAN"),
				eq(jobs.project_id, target.projectId),
				eq(jobs.environment_id, target.environmentId),
			),
		)
		.limit(1);
	if (!plan) {
		throw new PlanBindingError(
			"plan_not_found",
			`Job ${named} is not a plan of this environment. Plan this environment, review the plan, then apply it.`,
		);
	}
	if (plan.destroy_plan) {
		throw new PlanBindingError(
			"plan_is_destroy_plan",
			`Plan ${plan.id} is a destroy plan: it describes tearing this environment down, and a deploy never applies it. Plan this environment, review the plan, then apply it.`,
		);
	}
	const [laterRun] = await tx
		.select({ id: jobs.id })
		.from(jobs)
		.where(
			and(
				eq(jobs.environment_id, target.environmentId),
				inArray(jobs.job_type, [...RUN_JOB_TYPES]),
				gt(jobs.created_at, plan.created_at),
			),
		)
		.limit(1);
	const stale = planStaleReason({
		status: plan.status,
		planRevision: plan.configuration_hash,
		savedRevision: target.configurationHash,
		runSincePlan: Boolean(laterRun),
	});
	if (stale !== null && stale !== "no-plan") {
		throw new PlanBindingError("plan_not_current", staleMessage(stale, plan.id, plan.status));
	}
	const digest = planDigestOf(plan);
	if (!digest) {
		throw new PlanBindingError(
			"plan_digest_missing",
			`Plan ${plan.id} has no recorded plan digest, so the runner cannot confirm it applies that plan. Plan again, review the new plan, then apply it.`,
		);
	}
	return { planJobId: plan.id, planSha256: digest };
}
