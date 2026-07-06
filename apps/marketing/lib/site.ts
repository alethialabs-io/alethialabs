// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/** Canonical origin for the public marketing site (robots/sitemap absolute URLs).
 * Overridable per-deployment via NEXT_PUBLIC_SITE_URL. */
export const SITE_URL =
	process.env.NEXT_PUBLIC_SITE_URL ?? "https://alethialabs.io";

/** The public marketing pages, for the sitemap. Mirrors the marketing routes in
 * apps/console/microfrontends.json (the contact form has two sub-pages). */
export const MARKETING_SITEMAP_PATHS = [
	"/",
	"/pricing",
	"/enterprise",
	"/contact/sales",
	"/contact/enterprise",
	"/terms",
	"/privacy",
	"/cookies",
	"/acceptable-use",
];
