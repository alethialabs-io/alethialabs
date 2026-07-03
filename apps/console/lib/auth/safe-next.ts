// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Validates a post-auth `next` redirect target. Returns `raw` only when it's a
 * same-origin **relative** path — guarding against open redirects. Rejects
 * absolute/protocol-relative URLs (`https://…`, `//host`), backslash tricks, and
 * control characters (CR/LF injection). Use everywhere a `?next=` becomes a nav.
 */
export function safeNext(raw: string | null | undefined): string | null {
	if (!raw) return null;
	// Must be a rooted path, but not protocol-relative ("//host") or "/\".
	if (!raw.startsWith("/")) return null;
	if (raw.startsWith("//") || raw.startsWith("/\\")) return null;
	// No scheme or backslashes.
	if (raw.includes("://") || raw.includes("\\")) return null;
	// No control characters (e.g. header/CRLF injection via the redirect).
	for (let i = 0; i < raw.length; i++) {
		const code = raw.charCodeAt(i);
		if (code < 0x20 || code === 0x7f) return null;
	}
	return raw;
}
