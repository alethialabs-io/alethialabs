"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { headers } from "next/headers";
import { sendContactLeadEmail } from "@/lib/email/contact-email";
import { checkRateLimit } from "@/lib/rate-limit";
import {
	contactLeadSchema,
	normalizeWebsite,
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

/** What the form gets back: success, or a message written for the visitor plus any per-field errors. */
export type ContactLeadResult =
	| { ok: true }
	| { ok: false; error: string; fieldErrors?: Partial<Record<string, string>> };

/**
 * Public, unauthenticated handler for the contact form (every topic: product
 * demo, Enterprise trial, services project, something else). Validates the payload, drops obvious
 * bots via the honeypot, rate-limits per IP, and notifies the sales inbox.
 *
 * It RETURNS its failures instead of throwing them. A production Next.js build replaces the message
 * of an error thrown from a server action with a generic digest, so the rate-limit and "please
 * email us" sentences never reached a visitor — they saw a stock failure with no way forward.
 * Honeypot hits still return `{ ok: true }`, so bots get no signal.
 */
export async function submitContactLead(input: unknown): Promise<ContactLeadResult> {
	const result = contactLeadSchema.safeParse(input);
	if (!result.success) {
		const fieldErrors: Partial<Record<string, string>> = {};
		for (const issue of result.error.issues) {
			const key = issue.path[0];
			if (typeof key === "string" && !fieldErrors[key]) fieldErrors[key] = issue.message;
		}
		return { ok: false, error: "Some fields need another look.", fieldErrors };
	}
	const parsed = result.data;

	// Honeypot: a filled hidden field means a bot — accept silently, do nothing.
	if (parsed.honeypot && parsed.honeypot.trim().length > 0) {
		return { ok: true };
	}

	const ip = await clientIp();
	const { ok } = checkRateLimit(`contact:${ip}`, RATE_LIMIT, RATE_WINDOW_MS);
	if (!ok) {
		return {
			ok: false,
			error: `That is a lot of messages in a few minutes. Try again shortly, or email ${SALES_MAIL}.`,
		};
	}

	const { honeypot: _honeypot, ...rest }: ContactLeadInput = parsed;
	const lead = { ...rest, website: rest.website ? normalizeWebsite(rest.website) : undefined };

	try {
		await sendContactLeadEmail(lead);
	} catch {
		console.error("[contact] failed to notify sales; request details omitted");
		return {
			ok: false,
			error: `Your message did not go through on our side. Please email ${SALES_MAIL} and we will pick it up there.`,
		};
	}

	return { ok: true };
}
