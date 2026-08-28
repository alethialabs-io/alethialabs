"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { authorize, currentActor } from "@/lib/authz/guard";
import { assertJobQuotaAllowed } from "@/lib/billing/job-quota";
import { signedJob } from "@/lib/db/signed-job";
import { withActorScope } from "@/lib/db";
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
	// AUTHORIZE THE PROJECT, do not merely identify the caller (#2697).
	//
	// `currentActor()` answers "who is this", never "may they". `projectId` went straight into the
	// insert below, and RLS on `jobs` is ORG-scoped — so its WITH CHECK passes for any project in
	// the caller's org, and the job appears in that project's feed with its signed `verify_result`
	// readable by everyone who can see it.
	//
	// The caller is not only a person. `audit_infrastructure` (lib/ai/tools/scanner.ts) exposes
	// `projectId` to the MODEL as a free optional string, so the id can be chosen by prompt.
	//
	// The unattached path is legitimate — an audit of a plan that belongs to no project yet — so
	// identity alone still suffices when there is no id to authorize against.
	const actor = projectId
		? await authorize("audit", { type: "project", id: projectId })
		: await currentActor();
	const trimmed = input.trim();
	if (!trimmed) {
		throw new Error("Audit input is required (an OpenTofu plan JSON or k8s manifests).");
	}
	await assertJobQuotaAllowed(actor.orgId);

	const jobId = await withActorScope(actor, async (tx) => {
		const [job] = await tx
			.insert(jobs)
			.values(signedJob({
				user_id: actor.userId,
				...(projectId ? { project_id: projectId } : {}),
				job_type: "AUDIT",
				initiated_by: "user",
				status: "QUEUED",
				config_snapshot: { audit_kind: kind, audit_input: trimmed },
			}))
			.returning({ id: jobs.id });
		return job.id;
	});

	notifyScaler();
	return { jobId };
}
