"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { headers } from "next/headers";
import { sendContactLeadEmail } from "@/lib/email/contact-email";
import { checkRateLimit } from "@/lib/rate-limit";
import {
	contactLeadSchema,
	SALES_MAIL,
	type ContactLeadInput,
} from "@/lib/validations/contact.schema";

/** Max contact submissions accepted per client IP within the window. */
const RATE_LIMIT = 5;
/** Rate-limit window (10 minutes). */
const RATE_WINDOW_MS = 10 * 60 * 1000;

/** Best-effort client IP from the proxy headers, falling back to a shared key. */
async function clientIp(): Promise<string> {
	const h = await headers();
	const forwarded = h.get("x-forwarded-for");
	if (forwarded) return forwarded.split(",")[0]?.trim() || "unknown";
	return h.get("x-real-ip") ?? "unknown";
}

/**
 * Public, unauthenticated handler for the Talk-to-sales / Enterprise-trial
 * forms. Validates the payload, drops obvious bots via the honeypot, rate-limits
 * per IP, and notifies the sales inbox. Persisting leads to the database is a
 * deliberate follow-up — see the TODO below.
 *
 * Returns `{ ok: true }` on success (and silently for honeypot hits, so bots get
 * no signal); throws a user-safe Error otherwise for the client to surface.
 */
export async function submitContactLead(
	input: unknown,
): Promise<{ ok: true }> {
	const parsed = contactLeadSchema.parse(input);

	// Honeypot: a filled hidden field means a bot — accept silently, do nothing.
	if (parsed.honeypot && parsed.honeypot.trim().length > 0) {
		return { ok: true };
	}

	const ip = await clientIp();
	const { ok } = checkRateLimit(`contact:${ip}`, RATE_LIMIT, RATE_WINDOW_MS);
	if (!ok) {
		throw new Error(
			`Too many requests — please try again shortly or email ${SALES_MAIL}.`,
		);
	}

	const { honeypot: _honeypot, ...lead }: ContactLeadInput = parsed;

	try {
		await sendContactLeadEmail(lead);
	} catch (err) {
		console.error("[contact] failed to notify sales", err);
		throw new Error(
			`Something went wrong sending your request — please email ${SALES_MAIL}.`,
		);
	}

	// TODO(contact-submissions): persist the lead to a `contact_submissions`
	// table (Drizzle schema + migration) once it exists, so leads survive even if
	// email delivery is misconfigured. Logged for now so submissions aren't lost.
	console.info(
		`[contact] ${lead.type} lead from ${lead.email} (${lead.companySize}, ${lead.interest})`,
	);

	return { ok: true };
}
