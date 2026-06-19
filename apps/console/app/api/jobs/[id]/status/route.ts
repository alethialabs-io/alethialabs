// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { finalizeDeployment } from "@/app/server/actions/deployments";
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
				.select({ job_type: jobs.job_type, spec_id: jobs.spec_id })
				.from(jobs)
				.where(eq(jobs.id, jobId))
				.limit(1);

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

		return NextResponse.json({ success: true });
	} catch (err: unknown) {
		const message =
			err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
