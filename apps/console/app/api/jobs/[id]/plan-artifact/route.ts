// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { verifyWorkerToken } from "@/lib/workers/auth";
import { createServiceRoleClient } from "@/lib/supabase/service-role-client";
import { NextResponse } from "next/server";

const BUCKET = "plan-artifacts";

export async function POST(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { error: authError } = await verifyWorkerToken(req);
	if (authError) return authError;

	const { id: jobId } = await params;

	try {
		const body = await req.arrayBuffer();
		if (!body || body.byteLength === 0) {
			return NextResponse.json(
				{ error: "Empty body" },
				{ status: 400 },
			);
		}

		if (body.byteLength > 50 * 1024 * 1024) {
			return NextResponse.json(
				{ error: "File too large (max 50MB)" },
				{ status: 413 },
			);
		}

		const supabase = await createServiceRoleClient();
		const path = `${jobId}/terraform.plan.out`;

		const { error: uploadError } = await supabase.storage
			.from(BUCKET)
			.upload(path, body, {
				contentType: "application/octet-stream",
				upsert: true,
			});

		if (uploadError) {
			console.error("Plan artifact upload error:", uploadError);
			return NextResponse.json(
				{ error: "Upload failed: " + uploadError.message },
				{ status: 500 },
			);
		}

		return NextResponse.json({ key: path }, { status: 201 });
	} catch (err: unknown) {
		const message =
			err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}

export async function GET(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { error: authError } = await verifyWorkerToken(req);
	if (authError) return authError;

	const { id: jobId } = await params;

	try {
		const supabase = await createServiceRoleClient();
		const path = `${jobId}/terraform.plan.out`;

		const { data, error: downloadError } = await supabase.storage
			.from(BUCKET)
			.download(path);

		if (downloadError || !data) {
			return NextResponse.json(
				{ error: "Plan artifact not found" },
				{ status: 404 },
			);
		}

		const arrayBuffer = await data.arrayBuffer();
		return new Response(arrayBuffer, {
			status: 200,
			headers: {
				"Content-Type": "application/octet-stream",
				"Content-Disposition": `attachment; filename="terraform.plan.out"`,
			},
		});
	} catch (err: unknown) {
		const message =
			err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
