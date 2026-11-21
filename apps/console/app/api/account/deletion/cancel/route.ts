// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Cancels a scheduled account deletion from the emailed link (lib/privacy/self-deletion.ts). The
// link opens `/account/deletion`, whose button POSTs here — a GET never cancels, because a mail
// scanner prefetching the link would otherwise decide the person's deletion for them. The token is
// the authority: it reached only the account's own inbox, and it can do only this.

import { NextResponse } from "next/server";
import { isLinkTokenShape } from "@/lib/privacy/link-token";
import { cancelScheduledErasure } from "@/lib/privacy/self-deletion";

/** Withdraws the scheduled deletion the posted token names, then shows the page's result. */
export async function POST(req: Request): Promise<Response> {
	const form = await req.formData().catch(() => null);
	const raw = form?.get("t");
	const token = typeof raw === "string" ? raw : "";
	if (!isLinkTokenShape(token)) {
		return NextResponse.redirect(new URL("/account/deletion?result=invalid", req.url), 303);
	}
	const result = await cancelScheduledErasure({ token }, "link", new Date());
	const outcome = result.outcome === "cancelled" ? "cancelled" : "invalid";
	return NextResponse.redirect(new URL(`/account/deletion?result=${outcome}`, req.url), 303);
}
