// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The one-click unsubscribe endpoint (RFC 8058) that every `List-Unsubscribe` header points at, and
// the target of the confirmation page's button (`/email/unsubscribe`).
//
// POST only. A mail client's own "Unsubscribe" button sends `List-Unsubscribe=One-Click` as the body
// with no cookies, so there is no session to read: the signed token in the URL IS the authority,
// and it can do exactly one thing — turn off one category of mail to one address
// (lib/email/preferences.ts). A GET does nothing, because link scanners fetch every URL in a message.

import { NextResponse } from "next/server";
import {
	readUnsubscribeToken,
	setEmailPreference,
} from "@/lib/email/preferences";
import { checkRateLimit } from "@/lib/rate-limit";

/** Records the unsubscribe the token names. */
export async function POST(req: Request): Promise<Response> {
	const url = new URL(req.url);
	const token = url.searchParams.get("t") ?? "";
	const claim = readUnsubscribeToken(token);
	if (!claim) return NextResponse.json({ error: "invalid link" }, { status: 400 });

	// A courtesy bound per address: mail clients retry, but a loop hammering one token is not one.
	const limit = await checkRateLimit(`unsubscribe:${claim.email}`, 30, 3_600_000, { failOpen: true });
	if (!limit.ok) return NextResponse.json({ error: "too many requests" }, { status: 429 });

	const form = await req.formData().catch(() => null);
	const fromPage = form?.get("from") === "page";
	await setEmailPreference({
		email: claim.email,
		category: claim.category,
		enabled: false,
		source: fromPage ? "unsubscribe_page" : "one_click",
	});
	if (fromPage) {
		return NextResponse.redirect(
			new URL(`/email/unsubscribe?t=${encodeURIComponent(token)}&done=1`, req.url),
			303,
		);
	}
	return new NextResponse("Unsubscribed.", { status: 200 });
}
