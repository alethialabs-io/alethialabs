// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { finalizeDeployment } from "@/app/server/actions/deployments";
import { emitAlertEventSafe } from "@/lib/alerts/emit";
import { reportJobUsageOnce } from "@/lib/billing/meter";
import { getServiceDb } from "@/lib/db";
import { jobs, specs } from "@/lib/db/schema";
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
					spec_id: jobs.spec_id,
					org_id: jobs.org_id,
					zone_id: jobs.zone_id,
				})
				.from(jobs)
				.where(eq(jobs.id, jobId))
				.limit(1);

			// Ops alerts (free in core): job terminal state + spec destroy.
			if (job?.org_id && (status === "SUCCESS" || status === "FAILED")) {
				const base = {
					job_id: jobId,
					job_type: job.job_type,
					spec_id: job.spec_id ?? undefined,
					zone_id: job.zone_id ?? undefined,
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
						emitAlertEventSafe(job.org_id, "system.spec.destroyed", {
							title: "Spec destroyed",
							severity: "warning",
							...base,
						});
					}
				}
			}

			if (job?.spec_id) {
				const specId = job.spec_id;
				if (job.job_type === "DEPLOY") {
					if (status === "PROCESSING") {
						await db
							.update(specs)
							.set({ status: "PROVISIONING" })
							.where(eq(specs.id, specId));
					} else if (status === "FAILED") {
						await db
							.update(specs)
							.set({ status: "FAILED" })
							.where(eq(specs.id, specId));
					} else if (status === "SUCCESS") {
						try {
							await finalizeDeployment(jobId);
						} catch (err) {
							console.error("Finalize deployment error:", err);
							await db
								.update(specs)
								.set({ status: "FAILED" })
								.where(eq(specs.id, specId));
						}
					}
				} else if (job.job_type === "PLAN") {
					if (status === "FAILED") {
						await db
							.update(specs)
							.set({ status: "FAILED" })
							.where(eq(specs.id, specId));
					} else if (status === "SUCCESS") {
						await db
							.update(specs)
							.set({ status: "DRAFT" })
							.where(eq(specs.id, specId));
					}
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
