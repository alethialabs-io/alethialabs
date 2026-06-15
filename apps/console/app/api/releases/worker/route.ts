// SPDX-FileCopyrightText: 2026 Alethia OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { createServiceRoleClient } from "@/lib/supabase/service-role-client";
import { NextResponse } from "next/server";

/** CI calls this endpoint to publish a new worker release. */
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

	const supabase = await createServiceRoleClient();
	const { data, error } = await supabase
		.from("worker_releases")
		.insert({
			version,
			release_notes: release_notes ?? "",
			github_release_url: github_release_url ?? null,
			commit_sha: commit_sha ?? null,
			is_breaking: is_breaking ?? false,
		})
		.select("id")
		.single();

	if (error) {
		if (error.code === "23505") {
			return NextResponse.json(
				{ error: `Version ${version} already exists` },
				{ status: 409 },
			);
		}
		return NextResponse.json(
			{ error: "Failed to insert release: " + error.message },
			{ status: 500 },
		);
	}

	return NextResponse.json({ success: true, id: data.id });
}
