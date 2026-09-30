"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Per-environment infrastructure cost (W5).
//
// The pipeline already ran end to end and stopped one step short of the database: the runner runs
// Infracost on every PLAN and posts the breakdown on `execution_metadata.cost_breakdown`, and
// `parseCostBreakdown` already parses it. Nobody ever wrote it down. So "what does production cost?"
// had no answer, `estimated_monthly_cost` was a column nothing wrote, and the cost promotion gate
// was permanently inert.

import { and, desc, eq } from "drizzle-orm";
import { authorize } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";
import { environmentCost, projects } from "@/lib/db/schema";
import { parseCostBreakdown } from "@/lib/plan/parse-cost";
import type { CostResourceLine } from "@/types/jsonb.types";

/** The latest priced picture of an environment. */
export interface EnvironmentCost {
	totalMonthly: number | null;
	currency: string;
	resources: CostResourceLine[];
	capturedAt: string;
	planJobId: string | null;
}

/**
 * Persist a PLAN's Infracost breakdown as this environment's cost. Called by the job-status route
 * (service role) when a PLAN succeeds — the same seam `recordDriftPosture` uses for drift.
 *
 * Append-only: one row per (environment, plan). Keeping the history is what makes a cost DELTA
 * possible at all, which is what the promotion gate needs.
 */
export async function recordEnvironmentCost(input: {
	projectId: string;
	environmentId: string;
	planJobId: string;
	costBreakdown: Record<string, unknown>;
}): Promise<{ totalMonthly: number | null }> {
	const summary = parseCostBreakdown(input.costBreakdown);

	// Infracost prices resources by Terraform address — the SAME key the drift map uses — so a cost
	// line can be attributed back to the card that designed it.
	const resources: CostResourceLine[] = summary.resources.map((r) => ({
		address: r.name,
		resourceType: r.resourceType,
		monthlyCost: r.monthlyCost ?? 0,
	}));

	const db = getServiceDb();
	await db.insert(environmentCost).values({
		project_id: input.projectId,
		environment_id: input.environmentId,
		plan_job_id: input.planJobId,
		total_monthly: summary.totalMonthlyCost,
		currency: "USD",
		resources,
	});

	return { totalMonthly: summary.totalMonthlyCost };
}

/**
 * The latest cost for an environment. PDP-gated (view). `environment_cost` is an RLS-less
 * project-child table, so — exactly as in `getLatestDriftPosture` — the org boundary is enforced
 * HERE by joining to the parent project and filtering on the caller's org.
 *
 * Returns null when no plan has ever priced this environment, which is an honest "we don't know
 * yet" rather than a misleading zero.
 */
export async function getLatestEnvironmentCost(
	projectId: string,
	environmentId: string,
): Promise<EnvironmentCost | null> {
	const actor = await authorize("view", { type: "project", id: projectId });
	const db = getServiceDb();

	const [row] = await db
		.select({
			total_monthly: environmentCost.total_monthly,
			currency: environmentCost.currency,
			resources: environmentCost.resources,
			captured_at: environmentCost.captured_at,
			plan_job_id: environmentCost.plan_job_id,
		})
		.from(environmentCost)
		.innerJoin(projects, eq(environmentCost.project_id, projects.id))
		.where(
			and(
				eq(environmentCost.project_id, projectId),
				eq(environmentCost.environment_id, environmentId),
				eq(projects.org_id, actor.orgId),
			),
		)
		.orderBy(desc(environmentCost.captured_at))
		.limit(1);

	if (!row) return null;
	return {
		totalMonthly: row.total_monthly,
		currency: row.currency,
		resources: row.resources ?? [],
		capturedAt: row.captured_at.toISOString(),
		planJobId: row.plan_job_id,
	};
}

// The promotion gate's cost BASELINE (getPreviousEnvironmentCost) lives in
// lib/cost/previous-environment-cost.ts: it is service-role and unauthorized, so as an export of
// this `"use server"` file it was a public Server Action — and importing it from here dragged
// lib/auth into the runner-callback promotion lifecycle.
