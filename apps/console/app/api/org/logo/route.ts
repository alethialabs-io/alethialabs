// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Organization logo upload. Owner/admin of the active org POSTs the raw image bytes
// (Content-Type = the file's type); we store a single deterministic object per org
// (`org-logos/{orgId}/logo`, overwritten on re-upload) and set `organization.logo` to
// the served path `/api/org/{orgId}/logo?v={hash}` — the `?v` busts the client cache
// while the GET route always serves the current object. Mirrors the binary-body
// pattern of app/api/jobs/[id]/plan-artifact/route.ts.

import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { currentActor } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";
import { member, organization } from "@/lib/db/schema";
import { storage } from "@/lib/storage";

const BUCKET = "org-logos";
const MAX_BYTES = 2 * 1024 * 1024; // 2 MB
const ALLOWED = new Set([
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/svg+xml",
	"image/gif",
]);

/** Stores/updates the active organization's logo. */
export async function POST(req: Request): Promise<Response> {
	const actor = await currentActor();
	const orgId = actor.orgId;
	if (orgId === actor.userId) {
		return NextResponse.json({ error: "No active organization." }, { status: 400 });
	}

	// Only an owner/admin of the org may change its logo.
	const [m] = await getServiceDb()
		.select({ role: member.role })
		.from(member)
		.where(and(eq(member.organizationId, orgId), eq(member.userId, actor.userId)))
		.limit(1);
	if (!m || (m.role !== "owner" && m.role !== "admin")) {
		return NextResponse.json({ error: "Forbidden" }, { status: 403 });
	}

	const contentType = (req.headers.get("content-type") ?? "").split(";")[0].trim();
	if (!ALLOWED.has(contentType)) {
		return NextResponse.json(
			{ error: "Unsupported image type (png, jpeg, webp, gif, svg)." },
			{ status: 415 },
		);
	}

	const body = await req.arrayBuffer();
	if (!body.byteLength) {
		return NextResponse.json({ error: "Empty file." }, { status: 400 });
	}
	if (body.byteLength > MAX_BYTES) {
		return NextResponse.json({ error: "Image too large (max 2 MB)." }, { status: 413 });
	}

	const bytes = new Uint8Array(body);
	await storage.put(BUCKET, `${orgId}/logo`, bytes, contentType);

	const version = createHash("sha256").update(bytes).digest("hex").slice(0, 12);
	const url = `/api/org/${orgId}/logo?v=${version}`;
	await getServiceDb()
		.update(organization)
		.set({ logo: url, updatedAt: new Date() })
		.where(eq(organization.id, orgId));

	return NextResponse.json({ url }, { status: 201 });
}

/** Clears the active organization's logo (owner/admin). */
export async function DELETE(): Promise<Response> {
	const actor = await currentActor();
	const orgId = actor.orgId;
	if (orgId === actor.userId) {
		return NextResponse.json({ error: "No active organization." }, { status: 400 });
	}
	const [m] = await getServiceDb()
		.select({ role: member.role })
		.from(member)
		.where(and(eq(member.organizationId, orgId), eq(member.userId, actor.userId)))
		.limit(1);
	if (!m || (m.role !== "owner" && m.role !== "admin")) {
		return NextResponse.json({ error: "Forbidden" }, { status: 403 });
	}
	await getServiceDb()
		.update(organization)
		.set({ logo: null, updatedAt: new Date() })
		.where(eq(organization.id, orgId));
	return NextResponse.json({ ok: true });
}
