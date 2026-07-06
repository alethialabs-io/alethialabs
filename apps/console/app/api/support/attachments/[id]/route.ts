// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Download a support-case attachment. Look up the attachment + its case on the service
// DB, gate on the case's view permission (+ org match), then stream the object bytes.

import { NextResponse } from "next/server";
import { getOwner } from "@/lib/auth/owner";
import { getActiveScope } from "@/lib/auth/scope";
import { authorizeUserId } from "@/lib/authz/guard";
import { SUPPORT_ATTACHMENTS_BUCKET } from "@/lib/config/storage";
import { getServiceDb } from "@/lib/db";
import { supportCaseAttachments, supportCases } from "@/lib/db/schema";
import { storage } from "@/lib/storage";
import { eq } from "drizzle-orm";

/** Strips characters that would break the Content-Disposition filename. */
function headerSafeName(name: string): string {
	return name.replace(/["\r\n]+/g, "_");
}

export async function GET(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id: attachmentId } = await params;
	const db = getServiceDb();

	const [att] = await db
		.select({
			case_id: supportCaseAttachments.case_id,
			file_name: supportCaseAttachments.file_name,
			content_type: supportCaseAttachments.content_type,
			storage_key: supportCaseAttachments.storage_key,
		})
		.from(supportCaseAttachments)
		.where(eq(supportCaseAttachments.id, attachmentId))
		.limit(1);
	if (!att) {
		return NextResponse.json({ error: "Attachment not found" }, { status: 404 });
	}

	const owner = await getOwner();
	if (!owner) return new Response("Unauthorized", { status: 401 });

	const forbid = await authorizeUserId(owner, "view", {
		type: "support_case",
		id: att.case_id,
	});
	if (forbid) return forbid;

	const actor = await getActiveScope(owner);
	const [caseRow] = await db
		.select({ org_id: supportCases.org_id })
		.from(supportCases)
		.where(eq(supportCases.id, att.case_id))
		.limit(1);
	if (!caseRow || caseRow.org_id !== actor.orgId) {
		return NextResponse.json({ error: "Attachment not found" }, { status: 404 });
	}

	const data = await storage.get(SUPPORT_ATTACHMENTS_BUCKET, att.storage_key);
	if (!data) {
		return NextResponse.json({ error: "Attachment not found" }, { status: 404 });
	}

	// Copy into a concrete ArrayBuffer-backed view so it satisfies BodyInit.
	const out = new Uint8Array(data.byteLength);
	out.set(data);

	return new Response(out, {
		status: 200,
		headers: {
			"Content-Type": att.content_type || "application/octet-stream",
			"Content-Disposition": `attachment; filename="${headerSafeName(att.file_name)}"`,
		},
	});
}
