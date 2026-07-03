// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { cliJson } from "@/lib/cli/respond";
import { getServiceDb } from "@/lib/db";
import { cliReleases } from "@/lib/db/schema";
import { cliLatestReleaseWire } from "@/lib/validations/cli-contract";
import { desc } from "drizzle-orm";
import { NextResponse } from "next/server";

/** Returns the Postgres error code if present (e.g. 23505 unique violation). */
function pgErrorCode(err: unknown): string | undefined {
	if (typeof err === "object" && err !== null && "code" in err) {
		return String((err as { code: unknown }).code);
	}
	return undefined;
}

/**
 * Public: the latest published alethia CLI release. The CLI polls this to tell
 * the user when a newer version exists, so it is intentionally unauthenticated
 * (a logged-out user should still see the upgrade hint). Returns 404 when no
 * release has been published yet — the CLI treats that as "no info" and stays
 * silent.
 */
export async function GET() {
	const db = getServiceDb();
	const [latest] = await db
		.select({
			version: cliReleases.version,
			release_notes: cliReleases.release_notes,
			released_at: cliReleases.released_at,
			github_release_url: cliReleases.github_release_url,
			min_supported_version: cliReleases.min_supported_version,
		})
		.from(cliReleases)
		.orderBy(desc(cliReleases.released_at))
		.limit(1);

	if (!latest) {
		return NextResponse.json({ error: "No releases published" }, { status: 404 });
	}

	return cliJson(cliLatestReleaseWire, latest);
}

/** CI calls this endpoint to publish a new CLI release (mirrors runner releases). */
export async function POST(req: Request) {
	const authHeader = req.headers.get("authorization");
	const expected = process.env.RELEASE_API_SECRET;

	if (!expected || authHeader !== `Bearer ${expected}`) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	let body: {
		version?: string;
		release_notes?: string;
		github_release_url?: string;
		commit_sha?: string;
		min_supported_version?: string;
		is_breaking?: boolean;
	};
	try {
		body = await req.json();
	} catch {
		return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
	}

	const {
		version,
		release_notes,
		github_release_url,
		commit_sha,
		min_supported_version,
		is_breaking,
	} = body;
	if (!version || typeof version !== "string") {
		return NextResponse.json(
			{ error: "Missing required field: version" },
			{ status: 400 },
		);
	}

	try {
		const db = getServiceDb();
		const [row] = await db
			.insert(cliReleases)
			.values({
				version,
				release_notes: release_notes ?? "",
				github_release_url: github_release_url ?? null,
				commit_sha: commit_sha ?? null,
				min_supported_version: min_supported_version ?? null,
				is_breaking: is_breaking ?? false,
			})
			.returning({ id: cliReleases.id });

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
