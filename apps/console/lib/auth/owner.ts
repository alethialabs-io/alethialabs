// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { headers } from "next/headers";
import { auth } from "@/lib/auth";

/**
 * Returns the authenticated user's id — the owner scope passed to
 * withOwnerScope() for the per-owner RLS backstop. Identity comes from Better
 * Auth (Phase D); the contract (a uuid string or throw) is unchanged from the
 * Supabase era so every caller stays the same. Throws on no session.
 */
export async function requireOwner(): Promise<string> {
	const session = await auth.api.getSession({ headers: await headers() });
	if (!session?.user) throw new Error("Unauthorized");
	return session.user.id;
}

/** Like requireOwner() but returns null instead of throwing. */
export async function getOwner(): Promise<string | null> {
	const session = await auth.api.getSession({ headers: await headers() });
	return session?.user?.id ?? null;
}
