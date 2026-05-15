import { verifyCliToken } from "@/lib/cli/auth";
import { createServiceRoleClient } from "@/lib/supabase/service-role-client";
import { NextResponse } from "next/server";

export async function POST(req: Request) {
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

	try {
		const { vineyard_id } = await req.json();
		if (!vineyard_id) {
			return NextResponse.json(
				{ error: "vineyard_id is required" },
				{ status: 400 },
			);
		}

		const supabase = await createServiceRoleClient();

		const { data: vineyard, error: vineyardError } = await supabase
			.from("vineyards")
			.select("id")
			.eq("id", vineyard_id)
			.eq("user_id", userId)
			.single();

		if (vineyardError || !vineyard) {
			return NextResponse.json(
				{ error: "Vineyard not found or unauthorized" },
				{ status: 404 },
			);
		}

		const { data: job, error } = await supabase
			.from("bootstrap_jobs")
			.insert({
				vineyard_id,
				user_id: userId,
				status: "IN_PROGRESS",
			})
			.select()
			.single();

		if (error) {
			return NextResponse.json(
				{ error: `Failed to create bootstrap job: ${error.message}` },
				{ status: 500 },
			);
		}

		return NextResponse.json({ job }, { status: 201 });
	} catch {
		return NextResponse.json(
			{ error: "Invalid JSON body" },
			{ status: 400 },
		);
	}
}

export async function GET(req: Request) {
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

	const { searchParams } = new URL(req.url);
	const vineyardId = searchParams.get("vineyard_id");

	const supabase = await createServiceRoleClient();
	let query = supabase
		.from("bootstrap_jobs")
		.select("*")
		.eq("user_id", userId)
		.order("created_at", { ascending: false });

	if (vineyardId) {
		query = query.eq("vineyard_id", vineyardId);
	}

	const { data: jobs, error } = await query;
	if (error) {
		return NextResponse.json(
			{ error: `Failed to fetch bootstrap jobs: ${error.message}` },
			{ status: 500 },
		);
	}

	return NextResponse.json({ jobs });
}
