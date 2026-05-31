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

/** Sets (or clears) the default worker for the current user. */
export async function setDefaultWorker(workerId: string | null) {
	const supabase = await createClient();

	const {
		data: { user },
	} = await supabase.auth.getUser();

	if (!user) throw new Error("Unauthorized");

	const { error } = await supabase.rpc("set_default_worker", {
		p_worker_id: workerId,
	});

	if (error) throw new Error("Failed to set default worker: " + error.message);
}

export interface AvailableWorker {
	id: string;
	name: string;
	mode: string;
	status: string | null;
	is_default: boolean;
}

/** Returns all workers visible to the current user, default first. */
export async function getAvailableWorkers(): Promise<AvailableWorker[]> {
	const supabase = await createClient();

	const { data, error } = await supabase
		.from("workers")
		.select("id, name, mode, status, is_default")
		.order("is_default", { ascending: false })
		.order("name", { ascending: true });

	if (error) throw new Error("Failed to fetch workers: " + error.message);
	return (data as unknown as AvailableWorker[]) ?? [];
}
