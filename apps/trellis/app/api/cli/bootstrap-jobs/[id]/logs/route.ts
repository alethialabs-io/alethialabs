import { verifyCliToken } from "@/lib/cli/auth";
import { createServiceRoleClient } from "@/lib/supabase/service-role-client";
import { NextResponse } from "next/server";

export async function GET(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { payload, error: authError } = await verifyCliToken(req);
	if (authError) {
		return authError;
	}

	const userId = payload.sub;
	if (!userId) {
		return NextResponse.json(
			{ error: "Invalid token payload" },
			{ status: 400 },
		);
	}

	const { id } = await params;
	const supabase = await createServiceRoleClient();

	const { data: job, error: jobError } = await supabase
		.from("bootstrap_jobs")
		.select("id")
		.eq("id", id)
		.eq("user_id", userId)
		.single();

	if (jobError || !job) {
		return NextResponse.json(
			{ error: "Bootstrap job not found or unauthorized" },
			{ status: 404 },
		);
	}

	const { data: logs, error } = await supabase
		.from("bootstrap_logs")
		.select("*")
		.eq("job_id", id)
		.order("id", { ascending: true });

	if (error) {
		return NextResponse.json(
			{ error: `Failed to fetch bootstrap logs: ${error.message}` },
			{ status: 500 },
		);
	}

	return NextResponse.json({ logs });
}

export async function POST(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { payload, error: authError } = await verifyCliToken(req);
	if (authError) {
		return authError;
	}

	const userId = payload.sub;
	if (!userId) {
		return NextResponse.json(
			{ error: "Invalid token payload" },
			{ status: 400 },
		);
	}

	const { id } = await params;

	try {
		const { log_chunk, stream_type } = await req.json();
		if (!log_chunk) {
			return NextResponse.json(
				{ error: "log_chunk is required" },
				{ status: 400 },
			);
		}

		const supabase = await createServiceRoleClient();
		const { data: job, error: jobError } = await supabase
			.from("bootstrap_jobs")
			.select("id")
			.eq("id", id)
			.eq("user_id", userId)
			.single();

		if (jobError || !job) {
			return NextResponse.json(
				{ error: "Bootstrap job not found or unauthorized" },
				{ status: 404 },
			);
		}

		const { data: log, error } = await supabase
			.from("bootstrap_logs")
			.insert({
				job_id: id,
				log_chunk,
				stream_type: stream_type || "SYSTEM",
			})
			.select()
			.single();

		if (error) {
			return NextResponse.json(
				{ error: `Failed to create bootstrap log: ${error.message}` },
				{ status: 500 },
			);
		}

		return NextResponse.json({ log }, { status: 201 });
	} catch {
		return NextResponse.json(
			{ error: "Invalid JSON body" },
			{ status: 400 },
		);
	}
}
