// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Downloads a data export (lib/privacy/export.ts). Three things must hold at once: a signed-in
// browser session for the account the export is ABOUT, the token from the emailed link, and a link
// that has not expired. A wrong account and a wrong token answer the same 404, so this route says
// nothing about which references exist. The expiry is enforced here, not only by the sweep that
// later deletes the archive.

import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { readExportForDownload } from "@/lib/privacy/export";
import { isLinkTokenShape } from "@/lib/privacy/link-token";

const params = z.object({ reference: z.string().regex(/^DSR-[0-9A-F]{8}$/) });

/** Streams the export to its subject, or refuses. */
export async function GET(
	req: Request,
	ctx: { params: Promise<{ reference: string }> },
): Promise<Response> {
	const parsed = params.safeParse(await ctx.params);
	const token = new URL(req.url).searchParams.get("t") ?? "";
	if (!parsed.success || !isLinkTokenShape(token)) {
		return NextResponse.json({ error: "not found" }, { status: 404 });
	}
	const session = await auth.api.getSession({ headers: await headers() });
	if (!session?.user) {
		// Back to the same link after sign-in. The link carries the token, so it goes through
		// `next` as a path the login page validates as same-origin.
		const next = `/api/privacy/export/${parsed.data.reference}?t=${encodeURIComponent(token)}`;
		return NextResponse.redirect(new URL(`/login?next=${encodeURIComponent(next)}`, req.url));
	}
	const result = await readExportForDownload({
		reference: parsed.data.reference,
		token,
		userId: session.user.id,
		now: new Date(),
	});
	if (result.outcome === "not_found") {
		return NextResponse.json({ error: "not found" }, { status: 404 });
	}
	if (result.outcome === "expired") {
		return NextResponse.json(
			{ error: "This download link has expired. Request a new export from your account settings." },
			{ status: 410 },
		);
	}
	return new Response(Buffer.from(result.bytes), {
		status: 200,
		headers: {
			"content-type": "application/json; charset=utf-8",
			"content-disposition": `attachment; filename="alethia-data-${result.reference}.json"`,
			"cache-control": "no-store",
			"x-content-type-options": "nosniff",
		},
	});
}
