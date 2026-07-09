// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Staff attachment download. Cloudflare Access + the SUPPORT_STAFF_EMAILS allowlist gate the
// subdomain; assertStaff() is the in-app backstop. Staff are cross-tenant (they answer every
// org's cases), so there's no org filter — any real attachment id resolves. Fetches the object
// server-side and streams it (the store is internal in prod — seaweedfs:8333 — so a presigned
// URL wouldn't resolve from the browser; this is the same approach as the console customer route).

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { supportCaseAttachments } from "@repo/support/schema";
import { assertStaff } from "@/lib/auth/staff";
import { getServiceDb } from "@/lib/db";
import { getSupportAttachment } from "@/lib/storage";

/** Strips characters that would break the Content-Disposition filename. */
function headerSafeName(name: string): string {
	return name.replace(/["\r\n]+/g, "_");
}

export async function GET(
	_req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	try {
		await assertStaff();
	} catch {
		return NextResponse.json({ error: "Not authorized" }, { status: 403 });
	}

	const { id } = await params;
	const [att] = await getServiceDb()
		.select({
			file_name: supportCaseAttachments.file_name,
			content_type: supportCaseAttachments.content_type,
			storage_key: supportCaseAttachments.storage_key,
		})
		.from(supportCaseAttachments)
		.where(eq(supportCaseAttachments.id, id))
		.limit(1);
	if (!att) {
		return NextResponse.json({ error: "Attachment not found" }, { status: 404 });
	}

	const data = await getSupportAttachment(att.storage_key);
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
