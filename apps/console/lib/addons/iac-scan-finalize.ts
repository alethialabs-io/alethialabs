// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Writes a finished IAC_SCAN job's report back onto its BYO IaC source, pinning the scanned commit.
//
// This lives in lib/, NOT in app/server/actions/byo-iac.ts: it is service-role and does not
// authorize, and inside a `"use server"` file every export is a public POST-addressable Server
// Action (#5219). The pin it writes is the commit a deploy will actually apply — the TOCTOU guard
// assertIacSourceQueueable relies on — so it must be reachable only from the runner-facing
// job-status route, which has already verified the runner token.
//
// Do not add `"use server"` here.

import { and, eq } from "drizzle-orm";
import { getServiceDb } from "@/lib/db";
import { jobs, projectIacSources } from "@/lib/db/schema";

/**
 * Writes a finished IAC_SCAN job's report back onto its project_iac_sources row (called from the
 * job status route on SUCCESS/FAILED). Uses the service DB (the runner-facing status route has no
 * user session) and maps back via the row identity stashed in config_snapshot. `done` requires the
 * job to have SUCCEEDED with an ok report — and only then is the scanned commit pinned onto
 * commit_sha (the sha a deploy will actually apply). A not-ok / failed scan clears the pin, so
 * provisioning stays locked until a clean re-scan.
 */
export async function finalizeIacScan(jobId: string): Promise<void> {
	const db = getServiceDb();
	const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
	if (!job || job.job_type !== "IAC_SCAN") return;
	const snap = job.config_snapshot ?? {};
	const projectId = typeof snap.project_id === "string" ? snap.project_id : null;
	const environmentId = typeof snap.environment_id === "string" ? snap.environment_id : null;
	const iacSourceId = typeof snap.iac_source_id === "string" ? snap.iac_source_id : null;
	if (!projectId || !environmentId || !iacSourceId) return;

	const report = job.execution_metadata?.iac_scan_result ?? null;
	const done = job.status === "SUCCESS" && report !== null && report.ok;

	await db
		.update(projectIacSources)
		.set({
			scan_status: done ? "done" : "failed",
			scan_report: report,
			commit_sha: done ? (report?.commit_sha ?? null) : null,
			scanned_at: new Date(),
			updated_at: new Date(),
		})
		.where(
			and(
				eq(projectIacSources.id, iacSourceId),
				eq(projectIacSources.project_id, projectId),
				eq(projectIacSources.environment_id, environmentId),
			),
		);
}
