// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// C2 slug routing — the single source of truth for the Vercel-style drilldown URLs
// `/{org}/{project}/{env}`. Every link/navigation builds its href from these so
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

/** Org-segment values that must never be a real org slug — the static console/sibling
 * shadows plus the marketing zone's owned segments derived from microfrontends.json. A path
 * added to microfrontends.json is reserved automatically; scripts/check-marketing-routes.mjs
 * guards the rest of the chain (the marketing app/ routes + the Caddy mirror). */
export const RESERVED_SLUGS = new Set([
	...STATIC_RESERVED_SLUGS,
	...MARKETING_RESERVED_SEGMENTS,
]);

/** `/{org}` — org overview (its projects). */
export function orgHref(orgSlug: string): string {
	return `/${orgSlug}`;
}

/** `/{org}/~/{sub}` — an org-global page (jobs, runners, settings/…). The `~`
 * segment separates org-global routes from the `/{org}/{project}` project drilldown. */
export function globalHref(orgSlug: string, sub: string): string {
	return `/${orgSlug}/~/${sub}`;
}

/** `/{org}/{project}` — project (project) detail; resolves to its default environment. A
 * project is the top-level unit under the org. */
export function projectHref(orgSlug: string, projectSlug: string): string {
	return `/${orgSlug}/${projectSlug}`;
}

/** `/{org}/{project}/{sub}` — a project-scoped global page (jobs, clusters, usage,
 * environments), the project analogue of `globalHref`. `sub` is reserved
 * (RESERVED_PROJECT_CHILD_SLUGS) so it never collides with an environment name. */
export function projectGlobalHref(
	orgSlug: string,
	projectSlug: string,
	sub: string,
): string {
	return `/${orgSlug}/${projectSlug}/${sub}`;
}

/** `/{org}/{project}/settings/{sub}` — a project-scoped settings page (context-aware mirror
 * of the org `~/settings`). The literal `settings` segment is reserved per-project (see
 * RESERVED_PROJECT_CHILD_SLUGS) so it never collides with an environment name. */
export function projectSettingsHref(
	orgSlug: string,
	projectSlug: string,
	sub: string,
): string {
	return `/${orgSlug}/${projectSlug}/settings/${sub}`;
}

/** Literal path segments that live directly under `/{org}/{project}` and therefore shadow an
 * environment name — the project-scoped pages (settings + the project nav subs). A project slug
 * must also never be `~` (the org-global scope). `createProject` / `addEnvironment` feed these to
 * `pickFreeSlug` / name validation so generated slugs and env names skip them. */
export const RESERVED_PROJECT_CHILD_SLUGS = [
	"architecture",
	"settings",
	"jobs",
	"clusters",
	"usage",
	"environments",
];

/** `/{org}/{project}/architecture?environment_id={id}` — the project's Architecture (design canvas)
 * view focused on a specific environment. The environment lives in a query param (not a path
 * segment) so switching envs updates the active view in place; it carries the env id (stable across
 * renames). Architecture is the project's default view — the bare `/{org}/{project}` redirects here. */
export function envHref(
	orgSlug: string,
	projectSlug: string,
	environmentId: string,
): string {
	return `/${orgSlug}/${projectSlug}/architecture?environment_id=${encodeURIComponent(environmentId)}`;
}

/** Vercel-style name → URL slug. Canonical implementation lives in `./slug`; re-exported
 *  here so the many `@/lib/routing` callers keep a single import site. */
export { slugify } from "./slug";

/**
 * Picks a slug that doesn't collide with `taken` by appending `-2`, `-3`, …
 * (used by createZone / createProject to keep the per-scope unique constraints).
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
