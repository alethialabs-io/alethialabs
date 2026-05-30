import { verifyCliToken } from "@/lib/cli/auth";
import { createServiceRoleClient } from "@/lib/supabase/service-role-client";
import { createHash } from "crypto";
import { NextResponse } from "next/server";

export async function POST(req: Request) {
	const { payload, error: authError } = await verifyCliToken(req);
	if (authError) return authError;

	const userId = payload?.sub;
	if (!userId) {
		return NextResponse.json(
			{ error: "Invalid token payload" },
			{ status: 401 },
		);
	}

	try {
		const body = await req.json();
		const {
			job_type,
			vineyard_id,
			configuration_id,
			cluster_id,
			cloud_identity_id,
			config_snapshot,
		} = body;

		if (!job_type || !vineyard_id) {
			return NextResponse.json(
				{ error: "job_type and vineyard_id are required" },
				{ status: 400 },
			);
		}

		if (!["BOOTSTRAP", "DEPLOY", "DESTROY"].includes(job_type)) {
			return NextResponse.json(
				{
					error: "job_type must be BOOTSTRAP, DEPLOY, or DESTROY",
				},
				{ status: 400 },
			);
		}

		if (job_type === "DEPLOY" && !configuration_id) {
			return NextResponse.json(
				{ error: "configuration_id is required for DEPLOY jobs" },
				{ status: 400 },
			);
		}

		if (job_type === "DESTROY" && !cluster_id) {
			return NextResponse.json(
				{ error: "cluster_id is required for DESTROY jobs" },
				{ status: 400 },
			);
		}

		const supabase = await createServiceRoleClient();

		let snapshot = config_snapshot || {};
		let configHash: string | null = null;

		if (job_type === "DEPLOY" && configuration_id) {
			const { data: config, error: configError } = await supabase
				.from("vine_full")
				.select("*")
				.eq("id", configuration_id)
				.eq("user_id", userId)
				.single();

			if (configError || !config) {
				return NextResponse.json(
					{ error: "Configuration not found or unauthorized" },
					{ status: 404 },
				);
			}

			snapshot = config;
			configHash = createHash("sha256")
				.update(JSON.stringify(snapshot))
				.digest("hex");
		}

		const { data: job, error: insertError } = await supabase
			.from("provision_jobs")
			.insert({
				user_id: userId,
				vineyard_id,
				cloud_identity_id: cloud_identity_id || null,
				job_type,
				cluster_id: cluster_id || null,
				configuration_id: configuration_id || null,
				config_snapshot: snapshot,
				configuration_hash: configHash,
				status: "QUEUED",
			})
			.select()
			.single();

		if (insertError) {
			console.error("Failed to create job:", insertError);
			return NextResponse.json(
				{ error: "Failed to queue job: " + insertError.message },
				{ status: 500 },
			);
		}

		return NextResponse.json({ job }, { status: 201 });
	} catch (err: any) {
		return NextResponse.json(
			{ error: err.message || "Internal Server Error" },
			{ status: 500 },
		);
	}
}

export async function GET(req: Request) {
	const { payload, error: authError } = await verifyCliToken(req);
	if (authError) return authError;

	const userId = payload?.sub;
	if (!userId) {
		return NextResponse.json(
			{ error: "Invalid token payload" },
			{ status: 401 },
		);
	}

	const { searchParams } = new URL(req.url);
	const status = searchParams.get("status");
	const vineyardId = searchParams.get("vineyard_id");

	const supabase = await createServiceRoleClient();

	let query = supabase
		.from("provision_jobs")
		.select("*")
		.eq("user_id", userId)
		.order("created_at", { ascending: false });

	if (status) {
		query = query.eq("status", status);
	}

	if (vineyardId) {
		query = query.eq("vineyard_id", vineyardId);
	}

	const { data: jobs, error } = await query;

	if (error) {
		return NextResponse.json({ error: error.message }, { status: 500 });
	}

	return NextResponse.json({ jobs });
}
