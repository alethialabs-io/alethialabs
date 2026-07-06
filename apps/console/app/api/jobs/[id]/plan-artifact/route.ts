// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { verifyRunnerToken } from "@/lib/runners/auth";
import { storage } from "@/lib/storage";
import {
	MAX_PLAN_ARTIFACT_BYTES,
	PLAN_ARTIFACT_BUCKET,
	planArtifactKey,
	planArtifactSizeError,
} from "@/lib/storage/plan-artifact";
import { NextResponse } from "next/server";

export async function POST(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { error: authError } = await verifyRunnerToken(req);
	if (authError) return authError;

	const { id: jobId } = await params;

	try {
		const body = await req.arrayBuffer();
		const sizeError = planArtifactSizeError(body?.byteLength ?? 0);
		if (sizeError === "empty") {
			return NextResponse.json({ error: "Empty body" }, { status: 400 });
		}
		if (sizeError === "too_large") {
			return NextResponse.json(
				{ error: `File too large (max ${MAX_PLAN_ARTIFACT_BYTES / (1024 * 1024)}MB)` },
				{ status: 413 },
			);
		}

		const path = planArtifactKey(jobId);

		try {
			await storage.put(
				PLAN_ARTIFACT_BUCKET,
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
		const path = planArtifactKey(jobId);

		const data = await storage.get(PLAN_ARTIFACT_BUCKET, path);
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
