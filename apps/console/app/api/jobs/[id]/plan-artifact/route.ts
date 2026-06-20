// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { verifyRunnerToken } from "@/lib/runners/auth";
import { storage } from "@/lib/storage";
import { NextResponse } from "next/server";

const BUCKET = "plan-artifacts";

export async function POST(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { error: authError } = await verifyRunnerToken(req);
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

		const path = `${jobId}/tofu.plan.out`;

		try {
			await storage.put(
				BUCKET,
				path,
				new Uint8Array(body),
				"application/octet-stream",
			);
		} catch (uploadErr: unknown) {
			const message =
				uploadErr instanceof Error
					? uploadErr.message
					: "Upload failed";
			console.error("Plan artifact upload error:", uploadErr);
			return NextResponse.json(
				{ error: "Upload failed: " + message },
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
	const { error: authError } = await verifyRunnerToken(req);
	if (authError) return authError;

	const { id: jobId } = await params;

	try {
		const path = `${jobId}/tofu.plan.out`;

		const data = await storage.get(BUCKET, path);
		if (!data) {
			return NextResponse.json(
				{ error: "Plan artifact not found" },
				{ status: 404 },
			);
		}

		// Copy into a concrete ArrayBuffer-backed view so it satisfies BodyInit.
		const out = new Uint8Array(data.byteLength);
		out.set(data);

		return new Response(out, {
			status: 200,
			headers: {
				"Content-Type": "application/octet-stream",
				"Content-Disposition": `attachment; filename="tofu.plan.out"`,
			},
		});
	} catch (err: unknown) {
		const message =
			err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
