// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// What a recipient asked for, per mail category, and the signed links that let them ask.
//
// Two kinds of category, and the difference is the default:
//
//   product_updates          optional mail about the product. OFF until the person turns it on
//                            (consent is opt-in), from the preferences page.
//   alert_channel:<id>       one alert channel's mail to one address. ON by default — the channel's
//                            admin chose the recipient — until that recipient mutes it with the
//                            link in the message. The mute is per recipient, so one person leaving
//                            a channel does not silence it for everyone else on it.
//
// Transactional mail (sign-in codes, receipts, privacy requests, account deletion) has NO category
// and is never filtered here: a person cannot opt out of being told their account is about to be
// erased.
//
// A link token names an ADDRESS and a CATEGORY and is signed with a key derived from the auth
// secret. It does not expire: RFC 8058 expects the header in a message to keep working, and the
// worst a leaked token can do is stop one category of mail to one address — which its holder could
// equally do by pressing the button in that message.

import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getAuthConfig } from "@/lib/config/auth";
import { getServiceDb } from "@/lib/db";
import { emailPreference, user } from "@/lib/db/schema";

/** The optional categories a person chooses from on the preferences page. */
export const OPTIONAL_EMAIL_CATEGORIES = {
	product_updates: {
		label: "Product updates",
		description:
			"Occasional email about new features and changes to Alethia. Off unless you turn it on.",
		defaultEnabled: false,
	},
} as const;

/** One of {@link OPTIONAL_EMAIL_CATEGORIES}' keys. */
export type OptionalEmailCategory = keyof typeof OPTIONAL_EMAIL_CATEGORIES;

/** Every category a preference row may carry. */
export type EmailCategory = OptionalEmailCategory | `alert_channel:${string}`;

/** How a preference was set. Stored on the row, so a dispute about consent has an answer. */
export type EmailPreferenceSource = "preferences_page" | "one_click" | "unsubscribe_page";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for a string this module accepts as a category. */
export function isEmailCategory(value: string): value is EmailCategory {
	if (value in OPTIONAL_EMAIL_CATEGORIES) return true;
	const [kind, id] = value.split(":");
	return kind === "alert_channel" && id !== undefined && UUID.test(id);
}

/** The category of one alert channel's mail. */
export function alertChannelCategory(channelId: string): EmailCategory {
	return `alert_channel:${channelId}`;
}

/** What a category reads as when the address has never set it. */
export function defaultEnabled(category: EmailCategory): boolean {
	if (category === "product_updates") return OPTIONAL_EMAIL_CATEGORIES.product_updates.defaultEnabled;
	return true;
}

/** A human name for a category, for the unsubscribe confirmation page. */
export function categoryLabel(category: EmailCategory): string {
	if (category === "product_updates") return OPTIONAL_EMAIL_CATEGORIES.product_updates.label;
	return "Alerts from this alert channel";
}

/** The key form of an address: trimmed and lower-cased. */
export function normalizeEmail(email: string): string {
	return email.trim().toLowerCase();
}

/** Whether `email` should receive mail of `category` — its stored choice, else the default. */
export async function wantsEmail(email: string, category: EmailCategory): Promise<boolean> {
	const [row] = await getServiceDb()
		.select({ enabled: emailPreference.enabled })
		.from(emailPreference)
		.where(
			and(
				eq(emailPreference.email, normalizeEmail(email)),
				eq(emailPreference.category, category),
			),
		)
		.limit(1);
	return row ? row.enabled : defaultEnabled(category);
}

/** Every optional category's effective value for one address. */
export async function optionalPreferences(
	email: string,
): Promise<Record<OptionalEmailCategory, boolean>> {
	const rows = await getServiceDb()
		.select({ category: emailPreference.category, enabled: emailPreference.enabled })
		.from(emailPreference)
		.where(eq(emailPreference.email, normalizeEmail(email)));
	const stored = new Map(rows.map((r) => [r.category, r.enabled]));
	return {
		product_updates:
			stored.get("product_updates") ?? OPTIONAL_EMAIL_CATEGORIES.product_updates.defaultEnabled,
	};
}

/**
 * Records a choice. Idempotent: the row is keyed on address and category, so a repeated
 * one-click POST (mail clients retry) writes the same thing again.
 *
 * The account link is looked up from the address when the caller does not know it, so the
 * erasure register can reach a row written from an unsigned link too.
 */
export async function setEmailPreference(input: {
	email: string;
	category: EmailCategory;
	enabled: boolean;
	source: EmailPreferenceSource;
	userId?: string | null;
}): Promise<void> {
	const email = normalizeEmail(input.email);
	const db = getServiceDb();
	let userId = input.userId ?? null;
	if (!userId) {
		const [owner] = await db
			.select({ id: user.id })
			.from(user)
			.where(eq(user.email, email))
			.limit(1);
		userId = owner?.id ?? null;
	}
	await db
		.insert(emailPreference)
		.values({
			email,
			category: input.category,
			enabled: input.enabled,
			source: input.source,
			user_id: userId,
		})
		.onConflictDoUpdate({
			target: [emailPreference.email, emailPreference.category],
			set: {
				enabled: input.enabled,
				source: input.source,
				user_id: userId,
				updated_at: new Date(),
			},
		});
}

// ── Signed links ─────────────────────────────────────────────────────────────────────────────

/** What a link token names. */
export interface UnsubscribeClaim {
	email: string;
	category: EmailCategory;
}

/** The signing key: an HMAC of a fixed label under the auth secret, so it is never the secret itself. */
function linkKey(): Buffer {
	return createHmac("sha256", getAuthConfig().secret)
		.update("alethia/email-unsubscribe/v1")
		.digest();
}

/** base64url HMAC of `payload`. */
function sign(payload: string): string {
	return createHmac("sha256", linkKey()).update(payload).digest("base64url");
}

/** Mints the token an unsubscribe link carries for one address and category. */
export function unsubscribeToken(claim: UnsubscribeClaim): string {
	const payload = Buffer.from(
		JSON.stringify({ v: 1, e: normalizeEmail(claim.email), c: claim.category }),
	).toString("base64url");
	return `${payload}.${sign(payload)}`;
}

/** Reads a token back, or null when it is malformed or its signature does not verify. */
export function readUnsubscribeToken(token: string): UnsubscribeClaim | null {
	const [payload, mac, extra] = token.split(".");
	if (!payload || !mac || extra !== undefined) return null;
	const expected = Buffer.from(sign(payload));
	const given = Buffer.from(mac);
	if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	if (!("v" in parsed) || parsed.v !== 1) return null;
	if (!("e" in parsed) || typeof parsed.e !== "string") return null;
	if (!("c" in parsed) || typeof parsed.c !== "string" || !isEmailCategory(parsed.c)) return null;
	return { email: parsed.e, category: parsed.c };
}

/** The one-click endpoint a `List-Unsubscribe` header points at (POST only). */
export function oneClickUnsubscribeUrl(claim: UnsubscribeClaim): string {
	return `${getAuthConfig().baseURL}/api/email/unsubscribe?t=${encodeURIComponent(unsubscribeToken(claim))}`;
}

/** The confirmation page a link in the message body opens. */
export function unsubscribePageUrl(claim: UnsubscribeClaim): string {
	return `${getAuthConfig().baseURL}/email/unsubscribe?t=${encodeURIComponent(unsubscribeToken(claim))}`;
}
