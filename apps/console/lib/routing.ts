// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// C2 slug routing — the single source of truth for the Vercel-style drilldown URLs
// `/{org}/{zone}/{spec}/{env}`. Every link/navigation builds its href from these so
// the path shape changes in one place. The personal (no-org) scope uses the reserved
// `~` segment, which the `[org]` layout maps back to the user's personal scope.

import { MARKETING_RESERVED_SEGMENTS } from "@/lib/marketing-zone";

/** Reserved org segment for the personal (no organization) scope. */
export const PERSONAL_ORG_SLUG = "~";

/** Console route shadows + sibling apps (docs/blog) that aren't owned by the marketing
 * zone. The marketing-owned segments (`pricing`, `enterprise`, `contact`, the legal
 * pages, `mkt-assets`, …) are NOT listed here — they're derived from
 * microfrontends.json (see RESERVED_SLUGS) so they can never drift from the routing. */
const STATIC_RESERVED_SLUGS = [
	PERSONAL_ORG_SLUG,
	"dashboard",
	"auth",
	"api",
	"start",
	"cli",
	"invites",
	"_next",
	"blog",
	"docs",
];

/** Org-segment values that must never be a real org/zone slug — the static console/sibling
 * shadows plus the marketing zone's owned segments derived from microfrontends.json. A path
 * added to microfrontends.json is reserved automatically; scripts/check-marketing-routes.mjs
 * guards the rest of the chain (the marketing app/ routes + the Caddy mirror). */
export const RESERVED_SLUGS = new Set([
	...STATIC_RESERVED_SLUGS,
	...MARKETING_RESERVED_SEGMENTS,
]);

/** `/{org}` — org overview (its zones). */
export function orgHref(orgSlug: string): string {
	return `/${orgSlug}`;
}

/** `/{org}/~/{sub}` — an org-global page (jobs, runners, settings/…). The `~`
 * segment separates org-global routes from the `/{org}/{zone}` project drilldown. */
export function globalHref(orgSlug: string, sub: string): string {
	return `/${orgSlug}/~/${sub}`;
}

/** `/{org}/{zone}` — zone detail (its specs). */
export function zoneHref(orgSlug: string, zoneSlug: string): string {
	return `/${orgSlug}/${zoneSlug}`;
}

/** `/{org}/{zone}/{spec}` — spec (app) detail; resolves to its default environment. */
export function specHref(
	orgSlug: string,
	zoneSlug: string,
	specSlug: string,
): string {
	return `/${orgSlug}/${zoneSlug}/${specSlug}`;
}

/** `/{org}/{zone}/{spec}/{env}` — a specific environment of a spec. */
export function envHref(
	orgSlug: string,
	zoneSlug: string,
	specSlug: string,
	envName: string,
): string {
	return `/${orgSlug}/${zoneSlug}/${specSlug}/${envName}`;
}

/** Lowercases + slugifies a name (a-z0-9 and single dashes); "" → "". */
export function slugify(raw: string): string {
	return raw
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

/**
 * Picks a slug that doesn't collide with `taken` by appending `-2`, `-3`, …
 * (used by createZone / createSpec to keep the per-scope unique constraints).
 */
export function pickFreeSlug(
	base: string,
	taken: (string | null)[],
): string {
	const used = new Set(taken.filter((s): s is string => !!s));
	if (!used.has(base)) return base;
	let n = 2;
	while (used.has(`${base}-${n}`)) n++;
	return `${base}-${n}`;
}
