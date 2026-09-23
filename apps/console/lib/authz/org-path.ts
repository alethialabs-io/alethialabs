// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { PERSONAL_ORG_SLUG, RESERVED_SLUGS } from "@/lib/routing";

/**
 * The header `proxy.ts` publishes the request path on, read back by `lib/authz/org-scope.ts`.
 *
 * ITS OWN MODULE ON PURPOSE. `proxy.ts` is bundled for the proxy runtime, and `org-scope.ts`
 * imports the database and the drizzle schema to turn a slug into an org id. Importing the constant
 * from there would drag all of that into the proxy bundle. This module imports only
 * `lib/routing.ts`, whose one dependency is `lib/marketing-zone.ts` and a JSON file — no database,
 * no schema. The alternative — writing the literal twice — is a header name with two sources of
 * truth, which is the drift this repo has already paid for elsewhere.
 *
 * Set by the proxy with `Headers.set`, so an inbound value from a client is REPLACED, never merged.
 * There is one exception, a server action Next forwards to another worker. There the inbound value
 * is the one this proxy published on the first pass, and it is kept. See {@link orgPathToPublish}
 * for when that applies and what forging it would get a client.
 */
export const ORG_PATH_HEADER = "x-alethia-path";

/**
 * The header Next sets on a server action it forwards to another worker (`x-action-forwarded`,
 * written by `createForwardedActionResponse` in `next/dist/server/app-render/action-handler.js`).
 */
export const ACTION_FORWARDED_HEADER = "x-action-forwarded";

/** The `[org]` dynamic segment exactly, raw or percent-encoded (hex digits in either case). */
const ORG_PARAM_SEGMENT = /^(?:\[org\]|%5[bB]org%5[dD])$/;

/**
 * True when `pathname`'s FIRST segment names no concrete org — the only segment `urlOrgSlug()`
 * (`lib/authz/org-scope.ts`) reads. That is one of:
 *
 * - no first segment at all (`/`);
 * - the `[org]` route parameter itself, raw or percent-encoded — the pattern Next forwards to for a
 *   page under `app/(private)/[org]/`;
 * - a reserved top-level segment (`/start`, `/dashboard/[[...rest]]`, `/cli/login`, `/onboarding`,
 *   …), EXCEPT the personal segment `~`, which `urlOrgSlug()` resolves to a scope like any org slug.
 *
 * The reserved set is `RESERVED_SLUGS`, the same set `urlOrgSlug()` uses to decide a first segment
 * is not an org, so the two cannot disagree. It is not a hand list that can fall behind the route
 * tree: check 5 of `scripts/check-marketing-routes.mjs` fails when a top-level console route under
 * `app/` is missing from it.
 *
 * Anything else — a slug-shaped first segment, or a bracket in some LATER segment under one — names
 * an org, and this returns false.
 */
export function namesNoOrg(pathname: string): boolean {
	const first = pathname.split("/").find(Boolean);
	if (first === undefined) return true;
	if (ORG_PARAM_SEGMENT.test(first)) return true;
	return first !== PERSONAL_ORG_SLUG && RESERVED_SLUGS.has(first);
}

/**
 * The path to publish on {@link ORG_PATH_HEADER}: normally the request's own path, with one
 * exception, for Next's server-action forwarding (#5001).
 *
 * When a client posts an action to a page whose server bundle does not contain it, Next re-issues
 * the POST to "the first worker that has a handler for this action id"
 * (`selectWorkerForForwarding`, `next/dist/server/app-render/manifests-singleton.js`). The URL of
 * that request is the worker's ROUTE, not the address the user is on. It copies the original
 * request's headers across, including the path this proxy published on the first pass, and adds
 * {@link ACTION_FORWARDED_HEADER}.
 *
 * The worker can be an `[org]` page, whose route is a pattern such as `/[org]/~/new`. Publishing
 * that overwrote the real address, `currentActor()` looked up an org with the slug `[org]`, found
 * none, and threw `notFound()`, and the client showed "Organization not found" on a page the user
 * could open. The worker can equally be a STATIC page: `app/start/page.tsx` imports
 * `app/server/actions/billing.ts`, which `[org]` pages import too, and `/`, `/start` and
 * `/dashboard` all import `resolve.ts`. Which one is "first" is the build's manifest order, which
 * nothing here controls. Publishing `/start` would make `urlOrgSlug()` read a reserved segment,
 * return null, and fall back to the session's org — the action run against a tenant the address
 * did not name.
 *
 * So the inbound value is kept only when all three of these hold: Next marked the request as
 * forwarded, a value came in, and the request path's first segment names no concrete org
 * ({@link namesNoOrg}). Any other request has the header replaced as before — including a forwarded
 * one whose first segment IS an org, such as `/org-a/[x]`. Keeping the carried value there would
 * let a client scope the `[org]` layout (which reads `params.org`, here `org-a`) and the actions
 * and readers under it (which read this header) to two different orgs.
 *
 * What a client gains by forging the three: it can post an action to a path with no org in it and
 * choose the path `currentActor()` reads. That is no more than posting the same action to the path
 * it names. `urlScopedOrgId` still checks membership, so the only orgs it can reach are its own.
 */
export function orgPathToPublish(pathname: string, inbound: Headers): string {
	const carried = inbound.get(ORG_PATH_HEADER);
	if (
		carried &&
		inbound.get(ACTION_FORWARDED_HEADER) === "1" &&
		namesNoOrg(pathname)
	) {
		return carried;
	}
	return pathname;
}
