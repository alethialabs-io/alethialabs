import { createServiceRoleClient } from "@/lib/supabase/service-role-client";
import { createHash } from "crypto";
import { NextResponse } from "next/server";

export type WorkerAuthResult = {
	workerId: string;
	tokenHash: string;
	error: NextResponse | null;
};

export async function verifyWorkerToken(
	req: Request,
): Promise<WorkerAuthResult> {
	const workerId = req.headers.get("X-Worker-ID");
	const workerToken = req.headers.get("X-Worker-Token");

	if (!workerId || !workerToken) {
		return {
			workerId: "",
			tokenHash: "",
			error: NextResponse.json(
				{ error: "Missing X-Worker-ID or X-Worker-Token" },
				{ status: 401 },
			),
		};
	}

	const tokenHash = createHash("sha256").update(workerToken).digest("hex");

	const supabase = await createServiceRoleClient();
	const { data: worker, error } = await supabase
		.from("workers")
		.select("id, token_hash")
		.eq("id", workerId)
		.single();

	if (error || !worker || worker.token_hash !== tokenHash) {
		return {
			workerId: "",
			tokenHash: "",
			error: NextResponse.json(
				{ error: "Invalid worker ID or token" },
				{ status: 401 },
			),
		};
	}

	return { workerId, tokenHash, error: null };
}
