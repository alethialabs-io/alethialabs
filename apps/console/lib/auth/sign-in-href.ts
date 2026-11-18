// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { safeNext } from "./safe-next";

/**
 * The address of the sign-in page that returns to `next` afterwards. `next` is a path with its
 * query (`pathname + search`). It is kept only when `safeNext` accepts it, and dropped when it is
 * the root or the sign-in page itself, which would return the person to where they already are.
 */
export function signInHref(next?: string | null): string {
	const target = safeNext(next);
	if (target === null || target === "/") return "/login";
	if (target === "/login" || target.startsWith("/login?") || target.startsWith("/login/")) return "/login";
	return `/login?next=${encodeURIComponent(target)}`;
}
