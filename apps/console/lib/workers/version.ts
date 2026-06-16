"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only


import { createClient } from "@/lib/supabase/server";

export interface WorkerRelease {
	version: string;
	release_notes: string;
	released_at: string;
	github_release_url: string | null;
	commit_sha: string | null;
	is_breaking: boolean;
}

const RELEASE_COLUMNS =
	"version, release_notes, released_at, github_release_url, commit_sha, is_breaking" as const;

/** Fetches the most recent worker release from the database. */
export async function getLatestWorkerRelease(): Promise<WorkerRelease | null> {
	const supabase = await createClient();
	const { data } = await supabase
		.from("worker_releases")
		.select(RELEASE_COLUMNS)
		.order("released_at", { ascending: false })
		.limit(1)
		.single();

	return (data as WorkerRelease) ?? null;
}

/** Fetches release notes for a specific version. */
export async function getWorkerRelease(
	version: string,
): Promise<WorkerRelease | null> {
	const supabase = await createClient();
	const { data } = await supabase
		.from("worker_releases")
		.select(RELEASE_COLUMNS)
		.eq("version", version)
		.single();

	return (data as WorkerRelease) ?? null;
}
