import { verifyCliToken } from "@/lib/cli/auth";
import { createServiceRoleClient } from "@/lib/supabase/service-role-client";
import { createHash, randomBytes } from "crypto";
import { NextResponse } from "next/server";

/** Deploys a tendril by creating a worker record + queuing a DEPLOY_WORKER job. */
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
		const { name, cloud_identity_id, region, assigned_worker_id } = body;

		if (!name || !cloud_identity_id || !region) {
			return NextResponse.json(
				{ error: "name, cloud_identity_id, and region are required" },
				{ status: 400 },
			);
		}

		const supabase = await createServiceRoleClient();

		const { data: identity, error: identityError } = await supabase
			.from("cloud_identities")
			.select("id, provider, user_id")
			.eq("id", cloud_identity_id)
			.single();

		if (identityError || !identity) {
			return NextResponse.json(
				{ error: "Cloud identity not found" },
				{ status: 404 },
			);
		}

		if (identity.user_id !== userId) {
			return NextResponse.json(
				{ error: "Unauthorized: cloud identity belongs to another user" },
				{ status: 403 },
			);
		}

		const { data: latestRelease } = await supabase
			.from("worker_releases")
			.select("version")
			.order("released_at", { ascending: false })
			.limit(1)
			.single();

		const imageTag = latestRelease?.version ?? "latest";

		const workerToken = randomBytes(32).toString("hex");
		const tokenHash = createHash("sha256").update(workerToken).digest("hex");

		const { data: worker, error: workerError } = await supabase
			.from("workers")
			.insert({
				user_id: userId,
				name,
				mode: "self-hosted" as const,
				token_hash: tokenHash,
				cloud_identity_id,
			})
			.select("id, name")
			.single();

		if (workerError) {
			return NextResponse.json(
				{ error: "Failed to register tendril: " + workerError.message },
				{ status: 500 },
			);
		}

		const configSnapshot = {
			worker_id: worker.id,
			worker_token: workerToken,
			worker_name: name,
			image_tag: imageTag,
			region,
			cloud_provider: identity.provider ?? "aws",
			trellis_url:
				process.env.NEXT_PUBLIC_APP_URL || "https://adp.prod.itgix.eu",
		};

		const { data: job, error: jobError } = await supabase
			.from("provision_jobs")
			.insert({
				user_id: userId,
				cloud_identity_id,
				job_type: "DEPLOY_WORKER",
				config_snapshot: configSnapshot,
				status: "QUEUED",
				assigned_worker_id: assigned_worker_id || null,
			})
			.select("id, status, created_at")
			.single();

		if (jobError) {
			return NextResponse.json(
				{ error: "Failed to queue deployment: " + jobError.message },
				{ status: 500 },
			);
		}

		return NextResponse.json(
			{ tendril: worker, job },
			{ status: 201 },
		);
	} catch (err: unknown) {
		const message =
			err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
