"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { desc, eq } from "drizzle-orm";
import { getServiceDb } from "@/lib/db";
import { runnerReleases } from "@/lib/db/schema";

export interface RunnerRelease {
	version: string;
	release_notes: string;
	released_at: string;
	github_release_url: string | null;
	commit_sha: string | null;
	is_breaking: boolean;
}

const releaseColumns = {
	version: runnerReleases.version,
	release_notes: runnerReleases.release_notes,
	released_at: runnerReleases.released_at,
	github_release_url: runnerReleases.github_release_url,
	commit_sha: runnerReleases.commit_sha,
	is_breaking: runnerReleases.is_breaking,
};

/** Shapes a runner_releases row into the public RunnerRelease (released_at → ISO). */
function toRelease(row: {
	version: string;
	release_notes: string;
	released_at: Date;
	github_release_url: string | null;
	commit_sha: string | null;
	is_breaking: boolean;
}): RunnerRelease {
	return { ...row, released_at: row.released_at.toISOString() };
}

/** Fetches the most recent runner release from the database. */
export async function getLatestRunnerRelease(): Promise<RunnerRelease | null> {
	const [row] = await getServiceDb()
		.select(releaseColumns)
		.from(runnerReleases)
		.orderBy(desc(runnerReleases.released_at))
		.limit(1);
	return row ? toRelease(row) : null;
}

/** Fetches release notes for a specific version. */
export async function getRunnerRelease(
	version: string,
): Promise<RunnerRelease | null> {
	const [row] = await getServiceDb()
		.select(releaseColumns)
		.from(runnerReleases)
		.where(eq(runnerReleases.version, version))
		.limit(1);
	return row ? toRelease(row) : null;
}
