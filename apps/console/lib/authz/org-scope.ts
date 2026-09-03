// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// THE URL DECIDES THE TENANT, NOT THE SESSION (#4133).
//
// `app/(private)/[org]/layout.tsx` resolved the URL's `{org}` segment and then threw the answer
// away: every reader below it re-derived its tenant from the session instead. So when the session
// said tenant A and the URL said tenant B, nothing refused — the readers rendered **A's data under
// B's address**, with B's slug in the breadcrumb and B's name in the org switcher. That is what
// turned #4089 from a visible glitch into a silent cross-tenant write: the user had every reason to
// believe they were in B.
//
// WHY THE URL WINS RATHER THAN THE MISMATCH THROWING. A refusal reads like the stricter choice and
// is the weaker one, twice over:
//
//   · It breaks the org switcher. `use-workspace-store.ts` writes the session and then navigates,
//     so a correct switch spends a moment with the session on B and the address bar still on A.
//     A refusal fires there — on the one flow that is behaving exactly as designed.
//   · It leaves the session as a tenancy input. Whatever the guard's shape, `currentActor()` would
//     still be READING `active_organization_id` to decide, and the next reader added would still
//     inherit it. Sourcing the scope from the address means a mis-scoped session is not something
//     to be caught: it is not consulted.
//
// So `currentActor()` prefers this module's answer and falls back to the session only where there
// is no org in the address — `/dashboard`, `/cli/login`, `/api/**`, the MCP token path.
//
// WHAT IS STILL A REFUSAL. A URL that names an org the caller is not a member of yields no id and
// no fallback: it throws. Falling back to the session there would answer a request for someone
// else's tenant with the caller's own data — a wrong answer wearing a 200, which is the shape this
// whole issue is about.

import { and, eq } from "drizzle-orm";
import { headers } from "next/headers";
import { cache } from "react";
import { ORG_PATH_HEADER } from "@/lib/authz/org-path";
import { getServiceDb } from "@/lib/db";
import { member, organization } from "@/lib/db/schema";
import { PERSONAL_ORG_SLUG, RESERVED_SLUGS } from "@/lib/routing";

/** The `{org}` segment of the current request, or null when the address names no org. */
async function urlOrgSlug(): Promise<string | null> {
	let path: string | null = null;
	try {
		path = (await headers()).get(ORG_PATH_HEADER);
	} catch {
		// Outside a request scope (a script, a unit test, the MCP path before it binds an actor).
		return null;
	}
	if (!path) return null;
	const first = path.split("/").filter(Boolean)[0];
	if (!first) return null;
	if (first === PERSONAL_ORG_SLUG) return first;
	// Every non-org first segment is reserved by construction — `RESERVED_SLUGS` is what
	// `pickFreeSlug` refuses to mint, so "not reserved" and "is an org slug" are the same predicate
	// and cannot drift apart the way a second hand-written list of route prefixes would.
	return RESERVED_SLUGS.has(first) ? null : first;
}

/**
 * Resolve the address's `{org}` segment to an org id the caller may actually use.
 *
 * Memoized per render pass with React `cache()`: `currentActor()` is called many times in one
 * request and this must not become a query per call.
 *
 * @returns the org id, or null when the address names no org (→ the caller falls back to the
 *          session). NEVER null for an org segment that resolved to nothing — that throws.
 */
export const urlScopedOrgId = cache(
	async (userId: string): Promise<string | null> => {
		const slug = await urlOrgSlug();
		if (slug === null) return null;
		if (slug === PERSONAL_ORG_SLUG) return userId;

		const [org] = await getServiceDb()
			.select({ id: organization.id })
			.from(organization)
			.innerJoin(
				member,
				and(
					eq(member.organizationId, organization.id),
					eq(member.userId, userId),
				),
			)
			.where(eq(organization.slug, slug))
			.limit(1);

		// NOT a fallback. Answering a request addressed to an org the caller is not in with the
		// caller's OWN tenant is the substitution this issue exists to remove, and it would be
		// invisible: a 200, with the wrong tenant's rows under the requested org's slug. The page
		// tree turns this into the 404 it already renders for an unknown org
		// (`[org]/layout.tsx` → `notFound()`); a reader reached some other way gets an error.
		if (!org) {
			// "Forbidden", not "Unauthorized" — `[org]/layout.tsx` matches the bare word EXACTLY to
			// redirect to sign-in, and a session that is perfectly valid must not be sent there.
			throw new Error(
				`Forbidden: the address names organization \`${slug}\`, which this account is not a ` +
					"member of. The scope was NOT silently resolved from the session instead.",
			);
		}
		return org.id;
	},
);
