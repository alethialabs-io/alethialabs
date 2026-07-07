// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Shared display name + avatar initials for an account. One source of truth so names and
// avatars resolve identically everywhere (sidebar, members, access, SSO, activity feed).
// Pure string helpers (no React / I/O) so they're trivially unit-testable.

/** The minimal account shape these helpers read. Any extra fields are ignored. */
export interface NamedUser {
	name?: string | null;
	email?: string | null;
	username?: string | null;
}

/**
 * Display name for an account, by fallback: the real name, else the OAuth username, else the
 * email local-part (e.g. "borislav@tovr.eu" → "borislav"), else "User". Email-OTP signups
 * have no name, and some accounts have neither name nor username.
 */
export function displayName(user?: NamedUser | null): string {
	const name = user?.name?.trim();
	if (name) return name;
	const username = user?.username?.trim();
	if (username) return username;
	const local = user?.email?.split("@")[0]?.trim();
	if (local) return local;
	return "User";
}

/**
 * Two-letter initials for an avatar fallback, derived from the display name: first letters of
 * the first two words when the name has multiple parts (split on whitespace/`._-`), else the
 * first two characters. The "User" placeholder collapses to "U".
 */
export function userInitials(user?: NamedUser | null): string {
	const source = displayName(user);
	if (source === "User") return "U";
	const parts = source.split(/[\s._-]+/).filter(Boolean);
	const initials =
		parts.length >= 2 ? parts[0][0] + parts[1][0] : source.slice(0, 2);
	return initials.toUpperCase();
}
