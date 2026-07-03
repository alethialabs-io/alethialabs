// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Single source of truth for the marketing zone's owned paths: the hosted build reads
// apps/console/microfrontends.json directly (Vercel needs it static), so we derive
// everything else from it. RESERVED_SLUGS (lib/routing.ts) is computed from here, so a
// path added to microfrontends.json is reserved automatically — it can never drift from
// the routing. The Caddy mirror (deploy/caddy/marketing.caddy.example) and the
// filesystem (apps/marketing/app/) are kept honest by scripts/check-marketing-routes.mjs.

import microfrontends from "@/marketing-zones.json";

/** A slug-shaped path segment (lowercase a-z/0-9 + single hyphens) — the only thing an
 * org slug can be, and therefore the only thing that can collide with a marketing path.
 * Matches SLUG_RE in app/server/actions/onboarding.ts. */
const SLUG_SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The marketing zone's routing paths, exactly as declared in microfrontends.json
 * (e.g. "/", "/pricing", "/contact/:path*", "/mkt-assets/:path*", "/favicon.ico"). */
export const MARKETING_PATHS: string[] =
	microfrontends.applications.marketing.routing.flatMap((r) => r.paths);

/** The marketing zone's static asset prefix (no leading/trailing slash), e.g. "mkt-assets". */
export const MARKETING_ASSET_PREFIX: string =
	microfrontends.applications.marketing.assetPrefix;

/**
 * The top-level path segments the marketing zone owns, as reservable org slugs. Derived
 * from MARKETING_PATHS: take the first segment of each path, drop the bare root and any
 * non-slug-shaped tokens (params like `:path*`, dotted files like `favicon.ico` — neither
 * can be an org slug). Deduped. Yields e.g. pricing, enterprise, contact, terms, privacy,
 * cookies, acceptable-use, mkt-assets.
 */
export const MARKETING_RESERVED_SEGMENTS: string[] = [
	...new Set(
		MARKETING_PATHS.map((p) => p.replace(/^\//, "").split("/")[0]).filter((seg) =>
			SLUG_SEGMENT.test(seg),
		),
	),
];
