// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { MetadataRoute } from "next";

/**
 * Builds a `robots.txt` for a public, indexable site. `baseUrl` is the canonical
 * origin used for the `Sitemap:` line. Use from an app's `app/robots.ts`:
 * `export default function robots() { return brandRobots(SITE_URL); }`.
 */
export function brandRobots(baseUrl: string): MetadataRoute.Robots {
	return {
		rules: { userAgent: "*", allow: "/" },
		sitemap: `${baseUrl.replace(/\/$/, "")}/sitemap.xml`,
	};
}
