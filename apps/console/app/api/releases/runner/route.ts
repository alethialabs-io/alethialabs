// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { getServiceDb } from "@/lib/db";
import { runnerReleases } from "@/lib/db/schema";
import { NextResponse } from "next/server";
import { bearerMatches } from "@/lib/auth/internal-auth";

/** Returns the Postgres error code if present (e.g. 23505 unique violation). */
function pgErrorCode(err: unknown): string | undefined {
	if (typeof err === "object" && err !== null && "code" in err) {
		return String(err.code);
	}
	return undefined;
}

/** CI calls this endpoint to publish a new runner release. */
export async function POST(req: Request) {
	if (!bearerMatches(req, process.env.RELEASE_API_SECRET)) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	let body: {
		version?: string;
		release_notes?: string;
		github_release_url?: string;
		commit_sha?: string;
		is_breaking?: boolean;
	};
	try {
		body = await req.json();
	} catch {
		return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
	}

	const { version, release_notes, github_release_url, commit_sha, is_breaking } =
		body;
	if (!version || typeof version !== "string") {
		return NextResponse.json(
			{ error: "Missing required field: version" },
			{ status: 400 },
		);
	}

	try {
		const db = getServiceDb();
		const [row] = await db
			.insert(runnerReleases)
			.values({
				version,
				release_notes: release_notes ?? "",
				github_release_url: github_release_url ?? null,
				commit_sha: commit_sha ?? null,
				is_breaking: is_breaking ?? false,
			})
			.returning({ id: runnerReleases.id });

		return NextResponse.json({ success: true, id: row.id });
	} catch (err: unknown) {
		if (pgErrorCode(err) === "23505") {
			return NextResponse.json(
				{ error: `Version ${version} already exists` },
				{ status: 409 },
			);
		}
		const message =
			err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json(
			{ error: "Failed to insert release: " + message },
			{ status: 500 },
		);
	}
}
