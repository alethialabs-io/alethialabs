// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The header `proxy.ts` publishes the request path on, read back by `lib/authz/org-scope.ts`.
 *
 * ITS OWN MODULE ON PURPOSE. `proxy.ts` is bundled for the proxy runtime, and `org-scope.ts`
 * imports the database and the drizzle schema to turn a slug into an org id. Importing the constant
 * from there would drag all of that into the proxy bundle. A leaf with no imports is the seam; the
 * alternative — writing the literal twice — is a header name with two sources of truth, which is
 * the drift this repo has already paid for elsewhere.
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

/**
 * True when `pathname` is a route PATTERN, meaning some segment is a bracketed parameter name such
 * as `[org]` or `[...slug]`, raw or percent-encoded. No org slug can look like this: slugs are
 * lowercase letters, digits and hyphens.
 */
export function isRoutePatternPath(pathname: string): boolean {
	return pathname
		.split("/")
		.some((segment) => /^(\[|%5B).*(\]|%5D)$/i.test(segment));
}

/**
 * The path to publish on {@link ORG_PATH_HEADER}: normally the request's own path, with one
 * exception, for Next's server-action forwarding (#5001).
 *
 * When a client posts an action to a page whose server bundle does not contain it, Next re-issues
 * the POST to a worker that does. The URL of that request is the worker's ROUTE PATTERN, for
 * example `/[org]`, not the address the user is on. It copies the original request's headers
 * across, including the path this proxy published on the first pass, and adds
 * {@link ACTION_FORWARDED_HEADER}. Publishing the pattern here overwrote the real address with
 * `/[org]`. `currentActor()` then looked up an org with the slug `[org]`, found none, and threw
 * `notFound()`. A `notFound()` inside an action makes Next render the page tree for the request's
 * URL, even for a forwarded action, so the client got back the `/[org]` overview route for an org
 * named `[org]` and showed "Organization not found" on a page the user could open.
 *
 * So the inbound value is kept only when all three of these hold: Next marked the request as
 * forwarded, the path is a route pattern, and a value came in. Any other request, including one
 * that sends the forwarded header itself with a real path, has the header replaced as before.
 *
 * What a client gains by forging the three: it can post an action to `/[org]` and choose the path
 * `currentActor()` reads. That is no more than posting the same action to the path it names.
 * `urlScopedOrgId` still checks membership, so the only orgs it can reach are its own.
 */
export function orgPathToPublish(pathname: string, inbound: Headers): string {
	const carried = inbound.get(ORG_PATH_HEADER);
	if (
		carried &&
		inbound.get(ACTION_FORWARDED_HEADER) === "1" &&
		isRoutePatternPath(pathname)
	) {
		return carried;
	}
	return pathname;
}
