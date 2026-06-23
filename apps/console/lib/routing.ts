// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// C2 slug routing — the single source of truth for the Vercel-style drilldown URLs
// `/{org}/{zone}/{spec}/{env}`. Every link/navigation builds its href from these so
// the path shape changes in one place. The personal (no-org) scope uses the reserved
// `~` segment, which the `[org]` layout maps back to the user's personal scope.

/** Reserved org segment for the personal (no organization) scope. */
export const PERSONAL_ORG_SLUG = "~";

/** Org-segment values that must never be a real org/zone slug (they shadow routes). */
export const RESERVED_SLUGS = new Set([
	PERSONAL_ORG_SLUG,
	"dashboard",
	"auth",
	"api",
	"_next",
]);

/** `/{org}` — org overview (its zones). */
export function orgHref(orgSlug: string): string {
	return `/${orgSlug}`;
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
