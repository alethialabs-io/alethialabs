import { verifyCliToken } from "@/lib/cli/auth";
import { createServiceRoleClient } from "@/lib/supabase/service-role-client";
import { createHash } from "crypto";
import { NextResponse } from "next/server";

export async function POST(req: Request) {
	// 1. Authenticate CLI User
	const { payload, error } = await verifyCliToken(req);
	if (error) {
		return error;
	}

	const userId = payload?.sub;
	if (!userId) {
		return NextResponse.json(
			{ error: "Invalid token payload" },
			{ status: 401 },
		);
	}

	try {
		const { vine_id, cluster_id } = await req.json();

		if (!vine_id || !cluster_id) {
			return NextResponse.json(
				{ error: "vine_id and cluster_id are required" },
				{ status: 400 },
			);
		}

		const supabase = await createServiceRoleClient();

		// 2. Fetch the Vine (Configuration)
		const { data: vine, error: vineError } = await supabase
			.from("configurations")
			.select("*")
			.eq("id", vine_id)
			.eq("user_id", userId)
			.single();

		if (vineError || !vine) {
			return NextResponse.json(
				{ error: "Vine not found or unauthorized" },
				{ status: 404 },
			);
		}

		// 3. Create Config Snapshot
		// For now, we snapshot the whole row as JSON
		const configSnapshot = vine;
		const configHash = createHash("sha256")
			.update(JSON.stringify(configSnapshot))
			.digest("hex");

		// 4. Create Harvest record
		const { data: harvest, error: harvestError } = await supabase
			.from("harvests")
			.insert({
				user_id: userId,
				configuration_id: vine_id,
				cluster_id: cluster_id,
				config_snapshot: configSnapshot,
				configuration_hash: configHash,
				status: "QUEUED",
			})
			.select()
			.single();

		if (harvestError) {
			console.error("Failed to create harvest:", harvestError);
			return NextResponse.json(
				{ error: "Failed to queue harvest: " + harvestError.message },
				{ status: 500 },
			);
		}

		return NextResponse.json({ harvest }, { status: 201 });
	} catch (err: any) {
		return NextResponse.json(
			{ error: err.message || "Internal Server Error" },
			{ status: 500 },
		);
	}
}

export async function GET(req: Request) {
	const { payload, error } = await verifyCliToken(req);
	if (error) {
		return error;
	}

	const userId = payload?.sub;
	const { searchParams } = new URL(req.url);
	const vineyardId = searchParams.get("vineyard_id");

	const supabase = await createServiceRoleClient();

	let query = supabase
		.from("harvests")
		.select("*, configurations(*)")
		.eq("user_id", userId || "")
		.order("created_at", { ascending: false });

	if (vineyardId) {
		// Filter harvests whose vine belongs to the vineyard
		// This might need a join or a more complex query if we didn't add vineyard_id to harvests
		// Wait, I didn't add vineyard_id to harvests, only to vines.
		// But I added it to clusters!
		// Let's filter by cluster's vineyard.

		const { data: clusters } = await supabase
			.from("clusters")
			.select("id")
			.eq("vineyard_id", vineyardId);

		if (clusters && clusters.length > 0) {
			const clusterIds = clusters.map((c) => c.id);
			query = query.in("cluster_id", clusterIds);
		} else {
			return NextResponse.json({ harvests: [] });
		}
	}

	const { data: harvests, error: dbError } = await query;

	if (dbError) {
		return NextResponse.json({ error: dbError.message }, { status: 500 });
	}

	return NextResponse.json({ harvests });
}
