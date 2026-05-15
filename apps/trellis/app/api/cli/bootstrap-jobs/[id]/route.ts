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
	const { data: job, error } = await supabase
		.from("bootstrap_jobs")
		.select("*")
		.eq("id", id)
		.eq("user_id", userId)
		.single();

	if (error || !job) {
		return NextResponse.json(
			{ error: "Bootstrap job not found or unauthorized" },
			{ status: 404 },
		);
	}

	return NextResponse.json({ job });
}

export async function PUT(
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
		const { status, error_message } = await req.json();
		if (!status) {
			return NextResponse.json(
				{ error: "status is required" },
				{ status: 400 },
			);
		}

		const normalizedStatus = String(status).toUpperCase();
		const isTerminal = ["SUCCESS", "FAILED", "COMPLETED"].includes(
			normalizedStatus,
		);

		const supabase = await createServiceRoleClient();
		const updateData: {
			status: string;
			error_message?: string | null;
			updated_at: string;
			completed_at?: string;
		} = {
			status: normalizedStatus,
			error_message: error_message || null,
			updated_at: new Date().toISOString(),
		};

		if (isTerminal) {
			updateData.completed_at = updateData.updated_at;
		}

		const { data: job, error } = await supabase
			.from("bootstrap_jobs")
			.update(updateData)
			.eq("id", id)
			.eq("user_id", userId)
			.select()
			.single();

		if (error || !job) {
			return NextResponse.json(
				{ error: "Bootstrap job not found or unauthorized" },
				{ status: 404 },
			);
		}

		return NextResponse.json({ job });
	} catch {
		return NextResponse.json(
			{ error: "Invalid JSON body" },
			{ status: 400 },
		);
	}
}
