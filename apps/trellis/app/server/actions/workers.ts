"use server";

import { createClient } from "@/lib/supabase/server";
import { createHash, randomBytes } from "crypto";

export async function registerWorker(name: string, mode: "self-hosted" | "cloud-hosted") {
	const supabase = await createClient();

	const {
		data: { user },
	} = await supabase.auth.getUser();

	if (!user) {
		throw new Error("Unauthorized");
	}

	const workerToken = randomBytes(32).toString("hex");
	const tokenHash = createHash("sha256").update(workerToken).digest("hex");

	const { data: worker, error } = await supabase
		.from("workers")
		.insert({
			name,
			mode,
			token_hash: tokenHash,
		})
		.select("id, name, mode, status, created_at")
		.single();

	if (error) {
		throw new Error("Failed to register worker: " + error.message);
	}

	return { worker, worker_token: workerToken };
}
