import { verifyCliToken } from "@/lib/cli/auth";
import { createServiceRoleClient } from "@/lib/supabase/service-role-client";
import { NextResponse } from "next/server";

export async function GET(req: Request) {
	const { payload, error: authError } = await verifyCliToken(req);
	if (authError) {
		return authError;
	}

	const userId = payload.sub;
	if (!userId) {
		return new Response(
			JSON.stringify({ error: "Invalid token payload" }),
			{ status: 400 }
		);
	}

	const supabase = await createServiceRoleClient();
	const { data: vineyards, error } = await supabase
		.from("vineyards")
		.select("*, vines(id, project_name, environment_stage, status, region)")
		.eq("user_id", userId)
		.order("created_at", { ascending: false });

	if (error) {
		return new Response(JSON.stringify({ error: error.message }), { status: 500 });
	}

	return NextResponse.json({ vineyards });
}

export async function POST(req: Request) {
	const { payload, error: authError } = await verifyCliToken(req);
	if (authError) {
		return authError;
	}

	const userId = payload.sub;
	if (!userId) {
		return new Response(
			JSON.stringify({ error: "Invalid token payload" }),
			{ status: 400 }
		);
	}

	try {
		const body = await req.json();
		
		if (!body.name) {
			return new Response(JSON.stringify({ error: "Name is required" }), { status: 400 });
		}

		const supabase = await createServiceRoleClient();
		const { data: vineyard, error } = await supabase
			.from("vineyards")
			.insert({
				user_id: userId,
				name: body.name,
				description: body.description || null,
			})
			.select()
			.single();

		if (error) {
			return new Response(JSON.stringify({ error: error.message }), { status: 500 });
		}

		return NextResponse.json({ vineyard });
	} catch (e) {
		return new Response(JSON.stringify({ error: "Invalid JSON body" }), { status: 400 });
	}
}
