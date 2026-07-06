// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Upload an attachment to a support case. The authorize gate (authorizeUserId + org
// match) is the wall; the writes then run on the service DB (route context, no RLS).

import { NextResponse } from "next/server";
import { getOwner } from "@/lib/auth/owner";
import { getActiveScope } from "@/lib/auth/scope";
import { authorizeUserId } from "@/lib/authz/guard";
import { SUPPORT_ATTACHMENTS_BUCKET } from "@/lib/config/storage";
import { getServiceDb } from "@/lib/db";
import { supportCaseAttachments, supportCases } from "@/lib/db/schema";
import { storage } from "@/lib/storage";
import { eq } from "drizzle-orm";

/** Max accepted attachment size (10 MiB). */
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** Accepted content types (image/* wildcard + a small document/archive allowlist). */
const ALLOWED_EXACT = new Set([
	"application/pdf",
	"text/plain",
	"application/json",
	"application/zip",
	"application/gzip",
]);

/** True when `contentType` is permitted for a support attachment. */
function isAllowedContentType(contentType: string): boolean {
	return contentType.startsWith("image/") || ALLOWED_EXACT.has(contentType);
}

/** Collapses a filename to a path-safe storage segment. */
function safeName(name: string): string {
	return name.replace(/[^\w.-]+/g, "_").slice(0, 200) || "file";
}

export async function POST(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const owner = await getOwner();
	if (!owner) return new Response("Unauthorized", { status: 401 });

	const { id: caseId } = await params;

	const forbid = await authorizeUserId(owner, "reply", {
		type: "support_case",
		id: caseId,
	});
	if (forbid) return forbid;

	const actor = await getActiveScope(owner);
	const db = getServiceDb();

	const [caseRow] = await db
		.select({ id: supportCases.id, org_id: supportCases.org_id })
		.from(supportCases)
		.where(eq(supportCases.id, caseId))
		.limit(1);
	if (!caseRow || caseRow.org_id !== actor.orgId) {
		return NextResponse.json({ error: "Case not found" }, { status: 404 });
	}

	const form = await req.formData();
	const file = form.get("file");
	if (!(file instanceof File)) {
		return NextResponse.json(
			{ error: "Missing 'file' field" },
			{ status: 400 },
		);
	}

	if (file.size <= 0) {
		return NextResponse.json({ error: "Empty file" }, { status: 400 });
	}
	if (file.size > MAX_ATTACHMENT_BYTES) {
		return NextResponse.json(
			{ error: `File too large (max ${MAX_ATTACHMENT_BYTES / (1024 * 1024)}MB)` },
			{ status: 413 },
		);
	}

	const contentType = file.type || "application/octet-stream";
	if (!isAllowedContentType(contentType)) {
		return NextResponse.json(
			{ error: `Unsupported content type: ${contentType}` },
			{ status: 415 },
		);
	}

	const messageIdRaw = form.get("messageId");
	const messageId =
		typeof messageIdRaw === "string" && messageIdRaw.length > 0
			? messageIdRaw
			: null;

	const attachmentId = crypto.randomUUID();
	const fileName = file.name || "file";
	const storageKey = `support/${caseRow.org_id}/${caseId}/${attachmentId}/${safeName(fileName)}`;

	try {
		await storage.put(
			SUPPORT_ATTACHMENTS_BUCKET,
			storageKey,
			new Uint8Array(await file.arrayBuffer()),
			contentType,
		);
	} catch (uploadErr: unknown) {
		const message =
			uploadErr instanceof Error ? uploadErr.message : "Upload failed";
		console.error("Support attachment upload error:", uploadErr);
		return NextResponse.json(
			{ error: "Upload failed: " + message },
			{ status: 500 },
		);
	}

	await db.insert(supportCaseAttachments).values({
		id: attachmentId,
		case_id: caseId,
		message_id: messageId,
		uploaded_by: owner,
		file_name: fileName,
		content_type: contentType,
		size_bytes: file.size,
		storage_key: storageKey,
	});

	return NextResponse.json(
		{
			id: attachmentId,
			file_name: fileName,
			size_bytes: file.size,
			content_type: contentType,
		},
		{ status: 201 },
	);
}
