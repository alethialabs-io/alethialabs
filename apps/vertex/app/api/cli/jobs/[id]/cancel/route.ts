import { verifyCliToken } from "@/lib/cli/auth";
import { createServiceRoleClient } from "@/lib/supabase/service-role-client";
import { NextResponse } from "next/server";

/** Cancels a job owned by the CLI user. Only QUEUED/CLAIMED/PROCESSING jobs can be cancelled. */
export async function POST(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { payload, error: authError } = await verifyCliToken(req);
	if (authError) return authError;

	const userId = payload?.sub;
	if (!userId) {
		return NextResponse.json(
			{ error: "Invalid token payload" },
			{ status: 401 },
		);
	}

	const { id: jobId } = await params;

	try {
		const supabase = await createServiceRoleClient();

		const { data: job, error: fetchError } = await supabase
			.from("provision_jobs")
			.select("id, status, user_id")
			.eq("id", jobId)
			.eq("user_id", userId)
			.single();

		if (fetchError || !job) {
			return NextResponse.json(
				{ error: "Job not found or unauthorized" },
				{ status: 404 },
			);
		}

		const cancellable = ["QUEUED", "CLAIMED", "PROCESSING"];
		if (!cancellable.includes(job.status)) {
			return NextResponse.json(
				{
					error: `Cannot cancel job with status ${job.status}. Only QUEUED, CLAIMED, or PROCESSING jobs can be cancelled.`,
				},
				{ status: 400 },
			);
		}

		const { error: updateError } = await supabase
			.from("provision_jobs")
			.update({ status: "CANCELLED" })
			.eq("id", jobId);

		if (updateError) {
			return NextResponse.json(
				{ error: "Failed to cancel job: " + updateError.message },
				{ status: 500 },
			);
		}

		return NextResponse.json({ success: true });
	} catch (err: unknown) {
		const message =
			err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
