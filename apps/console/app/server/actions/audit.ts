"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { currentActor } from "@/lib/authz/guard";
import { withOwnerScope } from "@/lib/db";
import { jobs } from "@/lib/db/schema";
import { notifyScaler } from "@/lib/scaler";

/**
 * Queue an AUDIT job (elench "B" flow): the runner runs the verify engine over a
 * customer's EXISTING infrastructure — a bring-your-own OpenTofu/Terraform `show -json`
 * plan, or Kubernetes manifests — and posts the report to execution_metadata.verify_result.
 * Provisions nothing. Poll the result with the existing `getPlanResult`/`get_plan_result`
 * (which surfaces `verify_result` → the VerifyBlock).
 */
export async function queueAudit(
	input: string,
	kind: "plan" | "manifests",
	projectId?: string,
): Promise<{ jobId: string }> {
	const actor = await currentActor();
	const trimmed = input.trim();
	if (!trimmed) {
		throw new Error("Audit input is required (an OpenTofu plan JSON or k8s manifests).");
	}

	const jobId = await withOwnerScope(actor.userId, async (tx) => {
		const [job] = await tx
			.insert(jobs)
			.values({
				user_id: actor.userId,
				...(projectId ? { project_id: projectId } : {}),
				job_type: "AUDIT",
				status: "QUEUED",
				config_snapshot: { audit_kind: kind, audit_input: trimmed },
			})
			.returning({ id: jobs.id });
		return job.id;
	});

	notifyScaler();
	return { jobId };
}
