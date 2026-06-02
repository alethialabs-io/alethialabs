"use server";

import { createClient } from "@/lib/supabase/server";

export interface WorkerRelease {
	version: string;
	release_notes: string;
	released_at: string;
}

/** Fetches the most recent worker release from the database. */
export async function getLatestWorkerRelease(): Promise<WorkerRelease | null> {
	const supabase = await createClient();
	const { data } = await supabase
		.from("worker_releases")
		.select("version, release_notes, released_at")
		.order("released_at", { ascending: false })
		.limit(1)
		.single();

	return data ?? null;
}

/** Fetches release notes for a specific version. */
export async function getWorkerRelease(
	version: string,
): Promise<WorkerRelease | null> {
	const supabase = await createClient();
	const { data } = await supabase
		.from("worker_releases")
		.select("version, release_notes, released_at")
		.eq("version", version)
		.single();

	return data ?? null;
}
