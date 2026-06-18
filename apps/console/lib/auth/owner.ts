// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { createClient } from "@/lib/supabase/server";

/**
 * Returns the authenticated user's id — the owner scope passed to
 * withOwnerScope() for the per-owner RLS backstop. Identity still comes from
 * Supabase Auth during the de-Supabase data migration (P1); Better Auth (P3)
 * will replace the source without changing this contract. Throws on no session.
 */
export async function requireOwner(): Promise<string> {
	const supabase = await createClient();
	const {
		data: { user },
	} = await supabase.auth.getUser();
	if (!user) throw new Error("Unauthorized");
	return user.id;
}

/** Like requireOwner() but returns null instead of throwing. */
export async function getOwner(): Promise<string | null> {
	const supabase = await createClient();
	const {
		data: { user },
	} = await supabase.auth.getUser();
	return user?.id ?? null;
}
