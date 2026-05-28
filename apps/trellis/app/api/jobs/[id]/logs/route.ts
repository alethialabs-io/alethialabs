import { verifyWorkerToken } from "@/lib/workers/auth";
import { createServiceRoleClient } from "@/lib/supabase/service-role-client";
import { NextResponse } from "next/server";

export async function POST(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { workerId, tokenHash, error: authError } =
		await verifyWorkerToken(req);
	if (authError) return authError;

	const { id: jobId } = await params;

	try {
		const { log_chunk, stream_type } = await req.json();

		if (!log_chunk) {
			return NextResponse.json(
				{ error: "log_chunk is required" },
				{ status: 400 },
			);
		}

		const supabase = await createServiceRoleClient();

		const { error } = await supabase.rpc("insert_job_log", {
			p_worker_id: workerId,
			p_worker_token_hash: tokenHash,
			p_job_id: jobId,
			p_log_chunk: log_chunk,
			p_stream_type: stream_type || "STDOUT",
		});

		if (error) {
			console.error("Insert log RPC error:", error);
			return NextResponse.json(
				{ error: "Failed to insert log: " + error.message },
				{ status: 500 },
			);
		}

		return NextResponse.json({ success: true }, { status: 201 });
	} catch (err: any) {
		return NextResponse.json(
			{ error: err.message || "Internal Server Error" },
			{ status: 500 },
		);
	}
}

export async function GET(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { workerId, tokenHash, error: authError } =
		await verifyWorkerToken(req);
	if (authError) return authError;

	const { id: jobId } = await params;
	const { searchParams } = new URL(req.url);
	const after = searchParams.get("after");

	try {
		const supabase = await createServiceRoleClient();

		let query = supabase
			.from("job_logs")
			.select("*")
			.eq("job_id", jobId)
			.order("id", { ascending: true });

		if (after) {
			query = query.gt("id", parseInt(after, 10));
		}

		const { data: logs, error } = await query;

		if (error) {
			return NextResponse.json(
				{ error: error.message },
				{ status: 500 },
			);
		}

		return NextResponse.json({ logs });
	} catch (err: any) {
		return NextResponse.json(
			{ error: err.message || "Internal Server Error" },
			{ status: 500 },
		);
	}
}
