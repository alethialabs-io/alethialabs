// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { authorizeCli } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";
import { cloudIdentities, jobs, runnerReleases, runners } from "@/lib/db/schema";
import { notifyScaler } from "@/lib/scaler";
import { createHash, randomBytes } from "crypto";
import { desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { cliJson } from "@/lib/cli/respond";
import { deployRunnerWire } from "@/lib/validations/cli-contract";

/** Deploys a runner by creating a runner record + queuing a DEPLOY_RUNNER job. */
export async function POST(req: Request) {
	const auth = await authorizeCli(req, "deploy", { type: "runner" });
	if ("error" in auth) return auth.error;
	const { actor } = auth;

	try {
		const body = await req.json();
		const { name, cloud_identity_id, region, assigned_runner_id } = body;

		if (!name || !cloud_identity_id || !region) {
			return NextResponse.json(
				{ error: "name, cloud_identity_id, and region are required" },
				{ status: 400 },
			);
		}

		const db = getServiceDb();

		const [identity] = await db
			.select({
				id: cloudIdentities.id,
				provider: cloudIdentities.provider,
				org_id: cloudIdentities.org_id,
			})
			.from(cloudIdentities)
			.where(eq(cloudIdentities.id, cloud_identity_id))
			.limit(1);

		if (!identity) {
			return NextResponse.json(
				{ error: "Cloud identity not found" },
				{ status: 404 },
			);
		}

		if (identity.org_id !== actor.orgId) {
			return NextResponse.json(
				{ error: "Unauthorized: cloud identity belongs to another org" },
				{ status: 403 },
			);
		}

		const [latestRelease] = await db
			.select({ version: runnerReleases.version })
			.from(runnerReleases)
			.orderBy(desc(runnerReleases.released_at))
			.limit(1);

		const imageTag = latestRelease?.version ?? "latest";

		const runnerToken = randomBytes(32).toString("hex");
		const tokenHash = createHash("sha256").update(runnerToken).digest("hex");

		const [runner] = await db
			.insert(runners)
			.values({
				user_id: actor.userId,
				name,
				operator: "self",
				provisioning: "deployed",
				token_hash: tokenHash,
				cloud_identity_id,
			})
			.returning({ id: runners.id, name: runners.name });

		const configSnapshot = {
			runner_id: runner.id,
			runner_token: runnerToken,
			runner_name: name,
			image_tag: imageTag,
			region,
			cloud_provider: identity.provider ?? "aws",
			alethia_url:
				process.env.NEXT_PUBLIC_APP_URL || "https://alethialabs.io",
		};

		const [job] = await db
			.insert(jobs)
			.values({
				user_id: actor.userId,
				cloud_identity_id,
				job_type: "DEPLOY_RUNNER",
				config_snapshot: configSnapshot,
				status: "QUEUED",
				assigned_runner_id: assigned_runner_id || null,
			})
			.returning({
				id: jobs.id,
				status: jobs.status,
				created_at: jobs.created_at,
			});

		notifyScaler();
		return cliJson(deployRunnerWire, { runner, job }, { status: 201 });
	} catch (err: unknown) {
		const message =
			err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
