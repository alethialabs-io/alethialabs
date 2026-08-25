// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/** Canonical origin for the public marketing site (robots/sitemap absolute URLs).
 * Overridable per-deployment via NEXT_PUBLIC_SITE_URL. */
export const SITE_URL =
	process.env.NEXT_PUBLIC_SITE_URL ?? "https://alethialabs.io";

/** The public marketing pages, for the sitemap. Mirrors the marketing routes in
 * apps/console/marketing-zones.json (the contact form has two sub-pages).
 *
 * These two lists are maintained by hand and had drifted: /consumer-rights,
 * /ai-transparency and /legal/data-act were routable but absent here, so three
 * live pages were invisible to crawlers. /home is deliberately excluded — it is
 * the authenticated alias of / and carries `robots: { index: false }`. */
export const MARKETING_SITEMAP_PATHS = [
	"/",
	"/pricing",
	"/enterprise",
	"/open-source",
	"/brand",
	"/contact/sales",
	"/contact/enterprise",
	"/security",
	"/terms",
	"/imprint",
	"/privacy",
	"/privacy/requests",
	"/cookies",
	"/acceptable-use",
	"/consumer-rights",
	"/ai-transparency",
	"/legal/data-act",
	"/legal/dpa",
	"/legal/subprocessors",
	"/legal/source",
];
