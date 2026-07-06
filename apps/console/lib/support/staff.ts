// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Support-staff gate. Alethia support agents operate CROSS-TENANT (they view/answer every
// org's cases via getServiceDb, bypassing RLS), so there's no org membership or PDP grant
// to key on — the SUPPORT_STAFF_EMAILS allowlist IS the trust boundary. Used by the
// /support-admin layout, every staff server action, and the staff SSE route.

import { headers } from "next/headers";
import { env } from "next-runtime-env";
import { auth } from "@/lib/auth";

/** The identity of an authenticated support-staff member. */
export interface SupportStaff {
	userId: string;
	email: string;
	name: string;
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
 * Resolves the current session to a support-staff identity, or null when there's no
 * session or the user isn't on the allowlist. Non-throwing — for UI that conditionally
 * reveals a staff link.
 */
export async function getSupportStaff(): Promise<SupportStaff | null> {
	const session = await auth.api.getSession({ headers: await headers() });
	const user = session?.user;
	if (!user?.email || !isSupportStaff(user.email)) return null;
	return {
		userId: user.id,
		email: user.email,
		name: user.name || user.email,
	};
}

/**
 * Like {@link getSupportStaff} but throws when the caller isn't staff — the guard every
 * staff server action / stream route calls first. The layout uses getSupportStaff +
 * notFound() instead (to render a 404 rather than a 500).
 */
export async function assertStaff(): Promise<SupportStaff> {
	const staff = await getSupportStaff();
	if (!staff) throw new Error("Not authorized: support staff only");
	return staff;
}
