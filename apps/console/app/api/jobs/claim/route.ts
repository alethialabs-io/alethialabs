// SPDX-FileCopyrightText: 2026 Alethia OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { verifyWorkerToken } from "@/lib/workers/auth";
import { createServiceRoleClient } from "@/lib/supabase/service-role-client";
import { NextResponse } from "next/server";

export async function POST(req: Request) {
	const { workerId, tokenHash, error: authError } =
		await verifyWorkerToken(req);
	if (authError) return authError;

	try {
		const supabase = await createServiceRoleClient();

		const { data: worker } = await supabase
			.from("workers")
			.select("cloud_identity_id, mode")
			.eq("id", workerId)
			.single();

		const { data: jobs, error: claimError } = await supabase.rpc(
			"claim_next_job",
			{
				p_worker_id: workerId,
				p_worker_token_hash: tokenHash,
				p_cloud_identity_id: worker?.cloud_identity_id || undefined,
			},
		);

		if (claimError) {
			console.error("Claim RPC error:", claimError);
			return NextResponse.json(
				{ error: "Failed to claim job: " + claimError.message },
				{ status: 500 },
			);
		}

		if (!jobs || jobs.length === 0) {
			return NextResponse.json({ job: null });
		}

		const job = jobs[0];

		let cloud_identity = null;
		if (job.cloud_identity_id) {
			const { data: identity } = await supabase
				.from("cloud_identities")
				.select("credentials, provider")
				.eq("id", job.cloud_identity_id)
				.single();

			if (identity) {
				cloud_identity = {
					provider: identity.provider,
					role_arn: identity.credentials.role_arn ?? "",
					external_id: identity.credentials.external_id ?? "",
					account_id: identity.credentials.account_id ?? "",
					project_id: identity.credentials.project_id ?? "",
					service_account_email:
						identity.credentials.service_account_email ?? "",
					wif_config: identity.credentials.wif_config
						? JSON.stringify(identity.credentials.wif_config)
						: "",
					tenant_id: identity.credentials.tenant_id ?? "",
					client_id: identity.credentials.client_id ?? "",
					subscription_id:
						identity.credentials.subscription_id ?? "",
				};
			}
		}

		return NextResponse.json({ job, cloud_identity });
	} catch (err: any) {
		console.error("Claim error:", err);
		return NextResponse.json(
			{ error: "Internal Server Error" },
			{ status: 500 },
		);
	}
}
