import { verifyCliToken } from "@/lib/cli/auth";
import { createServiceRoleClient } from "@/lib/supabase/service-role-client";
import { createHash, randomBytes } from "crypto";
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
		const { name, mode, cloud_identity_id, metadata } = await req.json();

		if (!name || !mode) {
			return NextResponse.json(
				{ error: "name and mode are required" },
				{ status: 400 },
			);
		}

		if (mode !== "self-hosted" && mode !== "cloud-hosted") {
			return NextResponse.json(
				{ error: "mode must be 'self-hosted' or 'cloud-hosted'" },
				{ status: 400 },
			);
		}

		const workerToken = randomBytes(32).toString("hex");
		const tokenHash = createHash("sha256")
			.update(workerToken)
			.digest("hex");

		const supabase = await createServiceRoleClient();

		const { data: worker, error: insertError } = await supabase
			.from("workers")
			.insert({
				user_id: userId,
				name,
				mode,
				cloud_identity_id: cloud_identity_id || null,
				token_hash: tokenHash,
				metadata: metadata || {},
			})
			.select("id, name, mode, status, created_at")
			.single();

		if (insertError) {
			console.error("Failed to register worker:", insertError);
			return NextResponse.json(
				{ error: "Failed to register worker: " + insertError.message },
				{ status: 500 },
			);
		}

		return NextResponse.json(
			{
				worker,
				worker_token: workerToken,
			},
			{ status: 201 },
		);
	} catch (err: any) {
		return NextResponse.json(
			{ error: err.message || "Internal Server Error" },
			{ status: 500 },
		);
	}
}
