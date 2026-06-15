// SPDX-FileCopyrightText: 2026 Alethia OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { finalizeDeploymentWithClient } from "@/app/server/actions/deployments";
import { verifyWorkerToken } from "@/lib/workers/auth";
import { createServiceRoleClient } from "@/lib/supabase/service-role-client";
import { NextResponse } from "next/server";

export async function PUT(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { workerId, tokenHash, error: authError } =
		await verifyWorkerToken(req);
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

		const validStatuses = [
			"PROCESSING",
			"SUCCESS",
			"FAILED",
			"CANCELLED",
		];
		if (!validStatuses.includes(status)) {
			return NextResponse.json(
				{ error: `status must be one of: ${validStatuses.join(", ")}` },
				{ status: 400 },
			);
		}

		const supabase = await createServiceRoleClient();

		const { error } = await supabase.rpc("update_job_status", {
			p_worker_id: workerId,
			p_worker_token_hash: tokenHash,
			p_job_id: jobId,
			p_status: status,
			p_error_message: error_message || null,
			p_execution_metadata: execution_metadata || null,
		});

		if (error) {
			console.error("Update status RPC error:", error);
			return NextResponse.json(
				{ error: "Failed to update status: " + error.message },
				{ status: 500 },
			);
		}

		if (status === "PROCESSING" || status === "SUCCESS" || status === "FAILED") {
			const { data: job } = await supabase
				.from("provision_jobs")
				.select("job_type, vine_id")
				.eq("id", jobId)
				.single();

			if (job?.vine_id) {
				if (job.job_type === "DEPLOY") {
					if (status === "PROCESSING") {
						await supabase.from("vines").update({ status: "PROVISIONING" }).eq("id", job.vine_id);
					} else if (status === "FAILED") {
						await supabase.from("vines").update({ status: "FAILED" }).eq("id", job.vine_id);
					} else if (status === "SUCCESS") {
						try {
							await finalizeDeploymentWithClient(supabase, jobId);
						} catch (err) {
							console.error("Finalize deployment error:", err);
							await supabase.from("vines").update({ status: "FAILED" }).eq("id", job.vine_id);
						}
					}
				} else if (job.job_type === "PLAN") {
					if (status === "FAILED") {
						await supabase.from("vines").update({ status: "FAILED" }).eq("id", job.vine_id);
					} else if (status === "SUCCESS") {
						await supabase.from("vines").update({ status: "DRAFT" }).eq("id", job.vine_id);
					}
				}
			}
		}

		return NextResponse.json({ success: true });
	} catch (err: any) {
		return NextResponse.json(
			{ error: err.message || "Internal Server Error" },
			{ status: 500 },
		);
	}
}
