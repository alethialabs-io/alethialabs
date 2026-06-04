import { createServiceRoleClient } from "@/lib/supabase/service-role-client";
import { PublicWorkerMode } from "@/lib/validations/db.schemas";
import { createHash, randomBytes } from "crypto";
import { NextResponse } from "next/server";

/** Terraform calls this to register a cloud-hosted tendril. */
export async function POST(req: Request) {
	const authHeader = req.headers.get("authorization");
	const expected = process.env.RELEASE_API_SECRET;

	if (!expected || authHeader !== `Bearer ${expected}`) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	let body: { name?: string; mode?: PublicWorkerMode };
	try {
		body = await req.json();
	} catch {
		return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
	}

	const { name, mode } = body;
	if (!name || typeof name !== "string") {
		return NextResponse.json(
			{ error: "Missing required field: name" },
			{ status: 400 },
		);
	}

	const tendrilToken = randomBytes(32).toString("hex");
	const tokenHash = createHash("sha256").update(tendrilToken).digest("hex");

	const supabase = await createServiceRoleClient();
	const { data, error } = await supabase
		.from("workers")
		.upsert(
			{
				name,
				mode: mode ?? "cloud-hosted",
				token_hash: tokenHash,
			},
			{ onConflict: "name" },
		)
		.select("id")
		.single();

	if (error) {
		return NextResponse.json(
			{ error: "Failed to register tendril: " + error.message },
			{ status: 500 },
		);
	}

	return NextResponse.json({
		tendril_id: data.id,
		tendril_token: tendrilToken,
	});
}
