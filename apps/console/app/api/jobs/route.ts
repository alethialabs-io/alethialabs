// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { verifyCliToken } from "@/lib/cli/auth";
import { notifyScaler } from "@/lib/scaler";
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
			assigned_worker_id,
			plan_job_id,
		} = body;

		if (!job_type) {
			return NextResponse.json(
				{ error: "job_type is required" },
				{ status: 400 },
			);
		}

		const validJobTypes = [
			"DEPLOY",
			"DESTROY",
			"PLAN",
			"DESTROY_WORKER",
		];
		if (!validJobTypes.includes(job_type)) {
			return NextResponse.json(
				{
					error: `job_type must be one of: ${validJobTypes.join(", ")}`,
				},
				{ status: 400 },
			);
		}

		if ((job_type === "DEPLOY" || job_type === "PLAN") && !configuration_id) {
			return NextResponse.json(
				{ error: "configuration_id is required for DEPLOY and PLAN jobs" },
				{ status: 400 },
			);
		}

		if (job_type === "DESTROY" && !configuration_id) {
			return NextResponse.json(
				{ error: "configuration_id is required for DESTROY jobs" },
				{ status: 400 },
			);
		}

		const supabase = await createServiceRoleClient();

		let snapshot = config_snapshot || {};
		let configHash: string | null = null;
		let resolvedCloudIdentityId = cloud_identity_id || null;
		let resolvedVineyardId = vineyard_id || null;

		if (
			(job_type === "DEPLOY" || job_type === "PLAN" || job_type === "DESTROY") &&
			configuration_id
		) {
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

			if (!resolvedCloudIdentityId && config.cloud_identity_id) {
				resolvedCloudIdentityId = config.cloud_identity_id;
			}
			if (!resolvedVineyardId && config.vineyard_id) {
				resolvedVineyardId = config.vineyard_id;
			}
		}

		const { data: job, error: insertError } = await supabase
			.from("provision_jobs")
			.insert({
				user_id: userId,
				vineyard_id: resolvedVineyardId,
				cloud_identity_id: resolvedCloudIdentityId,
				job_type: job_type as "DEPLOY" | "DESTROY" | "PLAN" | "DESTROY_WORKER",
				vine_id: configuration_id || null,
				config_snapshot: snapshot,
				configuration_hash: configHash,
				status: "QUEUED",
				assigned_worker_id: assigned_worker_id || null,
				plan_job_id: plan_job_id || null,
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

		if (
			(job_type === "DEPLOY" || job_type === "PLAN") &&
			configuration_id
		) {
			await supabase
				.from("vines")
				.update({ status: "QUEUED" })
				.eq("id", configuration_id);
		}

		if (job_type === "DESTROY" && configuration_id) {
			await supabase
				.from("vines")
				.update({ status: "DESTROYING" })
				.eq("id", configuration_id);
		}

		notifyScaler();
		return NextResponse.json({ job }, { status: 201 });
	} catch (err: unknown) {
		const message =
			err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
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
	const limit = Math.min(parseInt(searchParams.get("limit") || "20", 10), 100);
	const offset = parseInt(searchParams.get("offset") || "0", 10);

	const supabase = await createServiceRoleClient();

	let query = supabase
		.from("provision_jobs")
		.select(
			"*, vines(project_name), workers!provision_jobs_worker_id_fkey(name)",
			{ count: "exact" },
		)
		.eq("user_id", userId)
		.order("created_at", { ascending: false })
		.range(offset, offset + limit - 1);

	if (status) {
		query = query.eq("status", status as any);
	}

	if (vineyardId) {
		query = query.eq("vineyard_id", vineyardId);
	}

	const { data, error, count } = await query;

	if (error) {
		return NextResponse.json({ error: error.message }, { status: 500 });
	}

	const jobs = (data ?? []).map((job: any) => ({
		...job,
		vine_name: job.vines?.project_name ?? null,
		worker_name: job.workers?.name ?? null,
		vines: undefined,
		workers: undefined,
	}));

	return NextResponse.json({ jobs, total: count ?? 0, limit, offset });
}
