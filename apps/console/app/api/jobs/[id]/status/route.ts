// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { finalizeDeployment } from "@/app/server/actions/deployments";
import { emitAlertEventSafe } from "@/lib/alerts/emit";
import { finalizeConnectionTest } from "@/lib/cloud-providers/connections";
import { reportJobUsageOnce } from "@/lib/billing/meter";
import { getServiceDb } from "@/lib/db";
import { jobs, projectEnvironments } from "@/lib/db/schema";
import { verifyRunnerToken } from "@/lib/runners/auth";

export async function PUT(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { runnerId, tokenHash, error: authError } =
		await verifyRunnerToken(req);
	if (authError) return authError;

	const { id: jobId } = await params;

	try {
		const { status, error_message, execution_metadata } = await req.json();

		if (!status) {
			return NextResponse.json(
				{ error: "status is required" },
				{ status: 400 },
			);
		}

		const validStatuses = ["PROCESSING", "SUCCESS", "FAILED", "CANCELLED"];
		if (!validStatuses.includes(status)) {
			return NextResponse.json(
				{ error: `status must be one of: ${validStatuses.join(", ")}` },
				{ status: 400 },
			);
		}

		const db = getServiceDb();

		await db.execute(
			sql`select update_job_status(${runnerId}::uuid, ${tokenHash}, ${jobId}::uuid, ${status}, ${error_message || null}, ${execution_metadata ? JSON.stringify(execution_metadata) : null}::jsonb)`,
		);

		if (status === "PROCESSING" || status === "SUCCESS" || status === "FAILED") {
			const [job] = await db
				.select({
					job_type: jobs.job_type,
					project_id: jobs.project_id,
					environment_id: jobs.environment_id,
					org_id: jobs.org_id,
					cloud_identity_id: jobs.cloud_identity_id,
				})
				.from(jobs)
				.where(eq(jobs.id, jobId))
				.limit(1);

			// Ops alerts (free in core): job start, terminal state, project destroy.
			if (job?.org_id && status === "PROCESSING") {
				emitAlertEventSafe(job.org_id, "system.job.started", {
					title: `Job started: ${job.job_type}`,
					severity: "info",
					job_id: jobId,
					job_type: job.job_type,
					project_id: job.project_id ?? undefined,
				});
			}
			if (job?.org_id && (status === "SUCCESS" || status === "FAILED")) {
				const base = {
					job_id: jobId,
					job_type: job.job_type,
					project_id: job.project_id ?? undefined,
				};
				if (status === "FAILED") {
					emitAlertEventSafe(job.org_id, "system.job.failed", {
						title: `Job failed: ${job.job_type}`,
						summary: error_message || undefined,
						severity: "critical",
						...base,
					});
				} else {
					emitAlertEventSafe(job.org_id, "system.job.succeeded", {
						title: `Job succeeded: ${job.job_type}`,
						severity: "info",
						...base,
					});
					if (job.job_type === "DESTROY") {
						emitAlertEventSafe(job.org_id, "system.project.destroyed", {
							title: "Project destroyed",
							severity: "warning",
							...base,
						});
					}
				}
			}

			// M1: provisioning status lives on the targeted environment (the job carries
			// environment_id). Legacy / non-project jobs without one simply skip the update.
			if (job?.project_id && job.environment_id) {
				const environmentId = job.environment_id;
				const setEnvStatus = (s: "PROVISIONING" | "FAILED" | "DRAFT") =>
					db
						.update(projectEnvironments)
						.set({ status: s })
						.where(eq(projectEnvironments.id, environmentId));
				if (job.job_type === "DEPLOY") {
					if (status === "PROCESSING") {
						await setEnvStatus("PROVISIONING");
					} else if (status === "FAILED") {
						await setEnvStatus("FAILED");
					} else if (status === "SUCCESS") {
						try {
							await finalizeDeployment(jobId);
						} catch (err) {
							console.error("Finalize deployment error:", err);
							await setEnvStatus("FAILED");
						}
					}
				} else if (job.job_type === "PLAN") {
					if (status === "FAILED") {
						await setEnvStatus("FAILED");
					} else if (status === "SUCCESS") {
						await setEnvStatus("DRAFT");
					}
				}
			}

			// CONNECTION_TEST: authoritatively finalize the cloud identity from the
			// terminal job result, server-side — so a connect sheet closed between
			// SUCCESS and the client refresh can't strand a passed test as unverified.
			if (
				job?.job_type === "CONNECTION_TEST" &&
				job.cloud_identity_id &&
				(status === "SUCCESS" || status === "FAILED")
			) {
				try {
					await finalizeConnectionTest(
						job.cloud_identity_id,
						status === "SUCCESS",
						{
							errorMessage: error_message ?? null,
							cached: execution_metadata?.cached_resources ?? undefined,
						},
					);
				} catch (err) {
					console.error("Finalize connection test error:", err);
				}
			}
		}

		// Bill managed-runner job-minutes once the job is terminal (best-effort; a
		// metering failure must never fail the runner's status update).
		if (status === "SUCCESS" || status === "FAILED") {
			try {
				await reportJobUsageOnce(jobId);
			} catch (err) {
				console.error("Usage metering failed:", err);
			}
		}

		return NextResponse.json({ success: true });
	} catch (err: unknown) {
		const message =
			err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
