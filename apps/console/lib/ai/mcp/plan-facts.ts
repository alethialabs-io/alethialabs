// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// What `get_plan_result` says about a plan beyond the in-app plan result: how many resources it adds,
// changes and destroys, the digest its verify receipt signed, and how much the environment's monthly
// cost moves if it is applied.

import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { appliedState } from "@/lib/approvals/binding";
import { currentActor } from "@/lib/authz/guard";
import type { Actor } from "@/lib/authz/types";
import { type Tx, withActorScope } from "@/lib/db";
import { environmentCost, projects } from "@/lib/db/schema";
import { parsePlanJSON } from "@/lib/plan/parse-plan";
import { readPlanResult } from "@/lib/rpc/procedures/jobs";
import type { PlanFacts } from "./reads";

/** A SHA-256 as the runner signs it: exactly 64 lowercase hex characters. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** The resource counts of a stored plan, or nulls when there is none or it does not parse. */
export function planCounts(planResult: Record<string, unknown> | undefined): Pick<PlanFacts, "adds" | "changes" | "destroys"> {
	if (!planResult) return { adds: null, changes: null, destroys: null };
	try {
		const { counts } = parsePlanJSON(planResult);
		// A replacement creates one resource and destroys another, so it counts on both sides.
		return {
			adds: counts.create + counts.replace,
			changes: counts.update,
			destroys: counts.delete + counts.replace,
		};
	} catch {
		return { adds: null, changes: null, destroys: null };
	}
}

/** The latest priced total of plan `planJobId` in the actor's org, or null. */
async function pricedPlan(tx: Tx, actor: Actor, planJobId: string) {
	const [row] = await tx
		.select({
			environment_id: environmentCost.environment_id,
			total_monthly: environmentCost.total_monthly,
			currency: environmentCost.currency,
		})
		.from(environmentCost)
		.innerJoin(projects, eq(environmentCost.project_id, projects.id))
		.where(and(eq(environmentCost.plan_job_id, planJobId), eq(projects.org_id, actor.orgId)))
		.orderBy(desc(environmentCost.captured_at))
		.limit(1);
	return row ?? null;
}

/**
 * The monthly cost change applying plan `planJobId` would make: its priced total minus the priced
 * total of the plan the environment's latest successful deploy applied, or minus nothing when nothing
 * was deployed there. Null when the plan is not priced, when the deployed state did not come from a
 * reviewed plan or that plan is not priced, or when the two are in different currencies.
 */
export async function planCostDelta(
	actor: Actor,
	planJobId: string,
): Promise<PlanFacts["monthly_cost_delta"]> {
	return withActorScope(actor, async (tx) => {
		const priced = await pricedPlan(tx, actor, planJobId);
		if (!priced || priced.total_monthly === null) return null;
		const applied = await appliedState(tx, priced.environment_id);
		let baseline = 0;
		if (applied) {
			if (!applied.planJobId) return null;
			const deployed = await pricedPlan(tx, actor, applied.planJobId);
			if (!deployed || deployed.total_monthly === null || deployed.currency !== priced.currency) return null;
			baseline = deployed.total_monthly;
		}
		return { amount_minor: Math.round((priced.total_monthly - baseline) * 100), currency: priced.currency };
	});
}

/**
 * The facts `get_plan_result` adds for job `jobId`. The plan result is read through the in-app read,
 * which authorizes the caller for the job before anything else is read.
 */
export async function readPlanFacts(jobId: string): Promise<PlanFacts> {
	const result = await readPlanResult(jobId);
	const actor = await currentActor();
	const metadata = result.execution_metadata;
	const digest = metadata?.verify_receipt?.receipt?.plan_sha256;
	return {
		...planCounts(metadata?.plan_result),
		plan_sha256: digest && SHA256_HEX.test(digest) ? digest : null,
		monthly_cost_delta: await planCostDelta(actor, jobId),
	};
}
