// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Staff attachment download. Cloudflare Access + the SUPPORT_STAFF_EMAILS allowlist gate the
// subdomain; assertStaff() is the in-app backstop. Staff are cross-tenant (they answer every
// org's cases), so there's no org filter — any real attachment id resolves. Rather than stream
// the bytes through this app, we mint a short-lived presigned GET URL and 302 the browser
// straight to storage (cheapest: zero app bandwidth, always a fresh URL, re-authorized per click).

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { supportCaseAttachments } from "@repo/support/schema";
import { assertStaff } from "@/lib/auth/staff";
import { getServiceDb } from "@/lib/db";
import { presignSupportAttachmentDownload } from "@/lib/storage";

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

	const url = await presignSupportAttachmentDownload(
		att.storage_key,
		att.file_name,
		att.content_type,
	);
	return NextResponse.redirect(url, 302);
}
