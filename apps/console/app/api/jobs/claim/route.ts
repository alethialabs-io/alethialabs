// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { getServiceDb } from "@/lib/db";
import { cloudIdentities, type Job, runners } from "@/lib/db/schema";
import { verifyWorkerToken } from "@/lib/workers/auth";
import { eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";

export async function POST(req: Request) {
	const { workerId, tokenHash, error: authError } =
		await verifyWorkerToken(req);
	if (authError) return authError;

	try {
		const db = getServiceDb();

		const [runner] = await db
			.select({ cloud_identity_id: runners.cloud_identity_id })
			.from(runners)
			.where(eq(runners.id, workerId))
			.limit(1);

		// claim_next_job returns SETOF jobs — typed via the execute generic.
		const claimed = await db.execute<Job>(
			sql`select * from claim_next_job(${workerId}::uuid, ${tokenHash}, ${runner?.cloud_identity_id ?? null}::uuid)`,
		);

		const job = claimed[0];
		if (!job) {
			return NextResponse.json({ job: null });
		}

		let cloud_identity = null;
		if (job.cloud_identity_id) {
			const [identity] = await db
				.select({
					credentials: cloudIdentities.credentials,
					provider: cloudIdentities.provider,
				})
				.from(cloudIdentities)
				.where(eq(cloudIdentities.id, job.cloud_identity_id))
				.limit(1);

			if (identity) {
				const c = identity.credentials;
				cloud_identity = {
					provider: identity.provider,
					role_arn: c.role_arn ?? "",
					external_id: c.external_id ?? "",
					account_id: c.account_id ?? "",
					project_id: c.project_id ?? "",
					service_account_email: c.service_account_email ?? "",
					wif_config: c.wif_config ? JSON.stringify(c.wif_config) : "",
					tenant_id: c.tenant_id ?? "",
					client_id: c.client_id ?? "",
					subscription_id: c.subscription_id ?? "",
				};
			}
		}

		return NextResponse.json({ job, cloud_identity });
	} catch (err) {
		console.error("Claim error:", err);
		return NextResponse.json(
			{ error: "Internal Server Error" },
			{ status: 500 },
		);
	}
}
