// SPDX-FileCopyrightText: 2026 Alethia OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { verifyCliToken } from "@/lib/cli/auth";
import { createServiceRoleClient } from "@/lib/supabase/service-role-client";
import { NextResponse } from "next/server";

/** Lists vine_cluster data joined with vine project_name for the CLI user. */
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

	try {
		const supabase = await createServiceRoleClient();

		const { data: clusters, error } = await supabase
			.from("vine_cluster")
			.select(`
				id,
				cluster_name,
				cluster_version,
				instance_types,
				node_min_size,
				node_max_size,
				node_desired_size,
				status,
				status_message,
				argocd_url,
				estimated_monthly_cost,
				created_at,
				updated_at,
				vines!inner (
					id,
					project_name,
					environment_stage,
					region,
					user_id
				)
			`)
			.eq("vines.user_id", userId)
			.order("updated_at", { ascending: false });

		if (error) {
			return NextResponse.json(
				{ error: error.message },
				{ status: 500 },
			);
		}

		const result = (clusters ?? []).map((c: any) => ({
			id: c.id,
			cluster_name: c.cluster_name,
			cluster_version: c.cluster_version,
			instance_types: c.instance_types,
			node_min_size: c.node_min_size,
			node_max_size: c.node_max_size,
			node_desired_size: c.node_desired_size,
			status: c.status,
			status_message: c.status_message,
			argocd_url: c.argocd_url,
			estimated_monthly_cost: c.estimated_monthly_cost,
			created_at: c.created_at,
			updated_at: c.updated_at,
			vine_project_name: c.vines?.project_name,
			vine_environment: c.vines?.environment_stage,
			vine_region: c.vines?.region,
		}));

		return NextResponse.json({ clusters: result });
	} catch (err: unknown) {
		const message =
			err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
