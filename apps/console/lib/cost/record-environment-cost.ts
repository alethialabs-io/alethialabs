// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Records a PLAN's Infracost breakdown as the environment's cost (W5).
//
// This lives in lib/, NOT in app/server/actions/cost.ts: it is service-role and does not authorize,
// and inside a `"use server"` file every export is a public POST-addressable Server Action — so
// anyone could append a fabricated cost row to any environment, and the promotion cost gate reads
// exactly those rows as its baseline (#5219). Its only caller is the runner-facing job-status route,
// which has already verified the runner token.
//
// Do not add `"use server"` here.

import { getServiceDb } from "@/lib/db";
import { environmentCost } from "@/lib/db/schema";
import { parseCostBreakdown } from "@/lib/plan/parse-cost";
import type { CostResourceLine } from "@/types/jsonb.types";

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
