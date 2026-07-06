// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The support-staff gate. Unlike the console (Better Auth sessions), this internal
// dashboard sits behind CLOUDFLARE ACCESS — the same pattern as the Umami dashboard.
// Access authenticates the request and forwards the verified identity in the
// `Cf-Access-Authenticated-User-Email` header; the SUPPORT_STAFF_EMAILS allowlist then
// AUTHORIZES it. That header + allowlist pair is the entire trust boundary: staff operate
// CROSS-TENANT (they view/answer every org's cases via getServiceDb, bypassing RLS), so
// there's no org membership or PDP grant to key on. Used by the pages (redirect/403), every
// staff server action, and the staff SSE route.

import { headers } from "next/headers";
import { env } from "next-runtime-env";
import { getServiceDb } from "@/lib/db";
import { user } from "@/lib/db-schema";
import { eq } from "drizzle-orm";

/** The identity of an authenticated support-staff member. */
export interface SupportStaff {
	userId: string;
	email: string;
	name: string;
}

/** The header Cloudflare Access sets with the verified caller's email. */
const ACCESS_EMAIL_HEADER = "cf-access-authenticated-user-email";

/**
 * The email of the current caller as asserted by Cloudflare Access, lowercased. Falls back
 * to `SUPPORT_ADMIN_DEV_EMAIL` in local dev when the Access header is absent (no tunnel in
 * front). Returns null when neither is present.
 */
export async function getStaffEmail(): Promise<string | null> {
	const h = await headers();
	const fromAccess = h.get(ACCESS_EMAIL_HEADER);
	const email = fromAccess || env("SUPPORT_ADMIN_DEV_EMAIL") || null;
	return email ? email.trim().toLowerCase() : null;
}

/** Parsed, lowercased allowlist from SUPPORT_STAFF_EMAILS (comma-separated). */
function staffAllowlist(): string[] {
	return (env("SUPPORT_STAFF_EMAILS") || "")
		.split(",")
		.map((e) => e.trim().toLowerCase())
		.filter(Boolean);
}

/** Whether an email is on the support-staff allowlist (case-insensitive). */
export function isSupportStaff(email: string | null | undefined): boolean {
	if (!email) return false;
	return staffAllowlist().includes(email.toLowerCase());
}

/**
 * Resolves the current caller (Access header → allowlist) to a support-staff identity,
 * looking up the `{id, name}` from the shared `user` table by email so replies/assignments
 * carry a real user id + display name. Returns null when there's no email, it isn't
 * allowlisted, OR the email has no Alethia account — the last matters because the staff
 * userId is written into uuid columns (support_messages.author_id, assigned_staff_id, the
 * per-staff read watermark), so a non-uuid fallback would corrupt writes. Staff are Alethia
 * employees with console accounts; an allowlisted email with no account is a misconfig.
 * Non-throwing — the pages render a 403 rather than crash.
 */
export async function getStaff(): Promise<SupportStaff | null> {
	const email = await getStaffEmail();
	if (!isSupportStaff(email) || !email) return null;
	const [row] = await getServiceDb()
		.select({ id: user.id, name: user.name })
		.from(user)
		.where(eq(user.email, email))
		.limit(1);
	if (!row) return null;
	return {
		userId: row.id,
		email,
		name: row.name ?? email,
	};
}

/**
 * Like {@link getStaff} but throws when the caller isn't staff — the guard every staff
 * server action / stream route calls first. Cloudflare Access should already have blocked a
 * non-staff request; this is the in-app authorization backstop.
 */
export async function assertStaff(): Promise<SupportStaff> {
	const staff = await getStaff();
	if (!staff) throw new Error("Not authorized: support staff only");
	return staff;
}
