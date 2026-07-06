// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { MetadataRoute } from "next";

/**
 * Builds a sitemap from a list of absolute-from-root paths (e.g. ["/", "/pricing"]).
 * `baseUrl` is the canonical origin; `lastModified` is passed in (callers stamp it —
 * `new Date()` is fine in a route handler) to keep this pure. Use from an app's
 * `app/sitemap.ts`: `return brandSitemap(SITE_URL, ["/", "/pricing"], new Date());`.
 */
export function brandSitemap(
	baseUrl: string,
	paths: string[],
	lastModified: Date,
): MetadataRoute.Sitemap {
	const origin = baseUrl.replace(/\/$/, "");
	return paths.map((p) => ({
		url: `${origin}${p === "/" ? "" : p}`,
		lastModified,
	}));
}
