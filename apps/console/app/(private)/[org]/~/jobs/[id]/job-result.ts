// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { formatMonthlyDelta, formatMonthlyRate } from "@repo/format";
import { z } from "zod";
import { parsePlanJSON } from "@/lib/plan/parse-plan";
import type { DriftDetail, DriftPosture, InfracostBreakdownTotals } from "@/types/jsonb.types";

// WHAT A FINISHED JOB FOUND (#6134), read from the structured result the runner already stored on
// the job row — `execution_metadata.drift_posture` for a DETECT_DRIFT job, `plan_result` (+
// `cost_breakdown`) for a PLAN. The job's STATUS keeps meaning "the job ran"; this is the finding.
//
// THE COLUMN IS TYPED, NOT VALIDATED. `jobs.execution_metadata` is `$type<ExecutionMetadata>()`,
// which is a compile-time promise about a payload a runner wrote — a runner from before a field
// existed, or one that wrote a partial result, hands the page something else. So every read here
// goes through a schema, and the three outcomes are kept apart on purpose:
//   - absent    → there is no result to state (an old job, a job type with none): the page says
//                 what it always said, and nothing reads as an error.
//   - malformed → a result exists and cannot be read: say so, and point at the log.
//   - a result  → the block.
//
// Environment drift's LATEST posture (`environment_drift`) is not read here: it is upserted per
// environment with no job id, so it would describe a newer scan than the job on screen.

/** How many drifted resources the block lists before the "Show all" disclosure. */
export const DRIFT_PREVIEW_COUNT = 5;

const driftDetailSchema: z.ZodType<DriftDetail> = z.object({
	address: z.string(),
	type: z.string(),
	// A kind a newer runner invents is still a drifted resource; it reads as "other" rather than
	// making the whole posture unreadable.
	kind: z.enum(["modified", "deleted", "other"]).catch("other"),
	attributes: z.array(z.string()).optional(),
});

// The runner's drift posture (packages/core/drift; typed here as `DriftPosture`). `in_sync` and
// `drifted` are the finding and are required; the
// rest is context. `unmanaged_known` defaults to FALSE when missing, because "we did not check" is
// the only honest reading of a posture that does not say.
const driftPostureSchema: z.ZodType<DriftPosture> = z.object({
	in_sync: z.boolean(),
	drifted: z.number().int().nonnegative(),
	details: z.array(driftDetailSchema).optional(),
	normalized: z.number().int().nonnegative().optional(),
	unmanaged: z.number().int().nonnegative().catch(0),
	unmanaged_known: z.boolean().catch(false),
	scanned_at: z.string().optional(),
});

// Infracost amounts are decimal strings; anything else is treated as not stated.
const amountSchema = z.string().optional().catch(undefined);

const costTotalsSchema: z.ZodType<InfracostBreakdownTotals> = z.object({
	// An ISO 4217 code or nothing — `Intl` throws on a code it does not know, and a cost line is
	// not worth an unrenderable page.
	currency: z
		.string()
		.regex(/^[A-Z]{3}$/)
		.optional()
		.catch(undefined),
	totalMonthlyCost: amountSchema,
	pastTotalMonthlyCost: amountSchema,
	diffTotalMonthlyCost: amountSchema,
});

/** A drift job's result, as the block renders it. */
interface DriftOutcome {
	kind: "drift";
	posture: DriftPosture;
}

/** A plan job's result, as the block renders it: the change counts and the cost line, if any. */
interface PlanOutcome {
	kind: "plan";
	counts: { create: number; update: number; delete: number; replace: number };
	/** The monthly cost change and the total after it, already formatted; null when not stated. */
	cost: { delta: string | null; total: string | null } | null;
}

/** A result exists on the job and could not be read. */
interface UnreadableOutcome {
	kind: "unreadable";
	subject: "drift" | "plan";
}

/** What the result block shows for a job; null when the job carries no structured result. */
export type JobResult = DriftOutcome | PlanOutcome | UnreadableOutcome | null;

/** Parses a decimal amount string; null when absent or not a finite number. */
function amount(value: string | undefined): number | null {
	if (value === undefined || value.trim() === "") return null;
	const n = Number(value);
	return Number.isFinite(n) ? n : null;
}

/**
 * The plan's cost line from a stored Infracost breakdown: the monthly CHANGE (a signed delta) and
 * the monthly total after it (a level). Null when the breakdown is absent or states neither.
 */
function readPlanCost(raw: unknown): PlanOutcome["cost"] {
	if (raw === undefined || raw === null) return null;
	const parsed = costTotalsSchema.safeParse(raw);
	if (!parsed.success) return null;
	const currency = parsed.data.currency ?? "USD";
	const diff = amount(parsed.data.diffTotalMonthlyCost);
	const total = amount(parsed.data.totalMonthlyCost);
	if (diff === null && total === null) return null;
	return {
		delta: diff === null ? null : formatMonthlyDelta(diff, "estimate", currency),
		total: total === null ? null : formatMonthlyRate(total, "estimate", currency),
	};
}

// What the counts depend on, checked STRICTLY. `parsePlanJSON` is lenient at every level by design
// (lib/plan/parse-plan.ts: a truncated plan "degrades to no changes") — right for the Plan tab's
// resource list, wrong here, where the result is a SENTENCE: a garbled `plan_result` would read as
// "No changes", a finding the plan never made. So a plan whose changes or actions are not where
// OpenTofu puts them is unreadable, and only a plan that passes this is counted.
//
// ONE ABSENCE IS A REAL ANSWER. OpenTofu's plan JSON omits `resource_changes` when it is empty, and
// the runner then stores the whole plan document instead of `{ resource_changes }`
// (apps/runner/internal/agent/runner.go, the PLAN metadata block). A plan document — it carries
// `format_version` — with no changes key is a plan with nothing to change, not an unreadable one.
const countablePlanSchema = z.object({
	resource_changes: z.array(z.object({ change: z.object({ actions: z.array(z.string()) }) })).optional(),
	format_version: z.string().optional(),
});

/** The plan's change counts; null when `plan_result` is not a readable OpenTofu plan. */
function readPlanCounts(raw: unknown): PlanOutcome["counts"] | null {
	const plan = countablePlanSchema.safeParse(raw);
	if (!plan.success) return null;
	if (plan.data.resource_changes === undefined) {
		return plan.data.format_version === undefined ? null : { create: 0, update: 0, delete: 0, replace: 0 };
	}
	const record = z.record(z.string(), z.unknown()).safeParse(raw);
	return record.success ? parsePlanJSON(record.data).counts : null;
}

// The three keys the block reads, each still unvalidated: the column's TYPE is not evidence of its
// shape (see the head of this file), so each is validated by its own reader below. `.optional()` is
// load-bearing: zod 4 REQUIRES a key whose schema is a bare `z.unknown()`, so without it every
// metadata object missing one of the three failed here and read as "no result".
const resultKeysSchema = z.object({
	drift_posture: z.unknown().optional(),
	plan_result: z.unknown().optional(),
	cost_breakdown: z.unknown().optional(),
});

/**
 * Reads the structured result of a FINISHED, SUCCESSFUL job. Anything other than a successful
 * DETECT_DRIFT or PLAN has no block (a failure keeps its own error panel), and so does a job whose
 * metadata carries no result at all. `execution_metadata` is taken as `unknown` on purpose: the
 * column is typed `ExecutionMetadata`, and that type is a promise this function does not rely on.
 */
export function readJobResult(job: { job_type: string; status: string; execution_metadata: unknown }): JobResult {
	if (job.status !== "SUCCESS") return null;
	const meta = resultKeysSchema.safeParse(job.execution_metadata);
	if (!meta.success) return null;
	const { drift_posture, plan_result, cost_breakdown } = meta.data;

	if (job.job_type === "DETECT_DRIFT") {
		if (drift_posture === undefined || drift_posture === null) return null;
		const parsed = driftPostureSchema.safeParse(drift_posture);
		return parsed.success ? { kind: "drift", posture: parsed.data } : { kind: "unreadable", subject: "drift" };
	}

	if (job.job_type === "PLAN") {
		if (plan_result === undefined || plan_result === null) return null;
		const counts = readPlanCounts(plan_result);
		if (!counts) return { kind: "unreadable", subject: "plan" };
		return { kind: "plan", counts, cost: readPlanCost(cost_breakdown) };
	}

	return null;
}

/** "1 resource" / "21 resources" — a count with its noun agreed. */
export function countNoun(n: number, singular: string, plural = `${singular}s`): string {
	return `${n} ${n === 1 ? singular : plural}`;
}
