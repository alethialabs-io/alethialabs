// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// How every `[project]` page and the `[project]` layout turn the URL's project slug into an id
// (CON-SM4, spec §4.5). A failed resolution is one of three different things, and each has its own
// answer:
//   · the slug names no project this viewer can see → the project 404;
//   · there is no session any more                   → sign-in, coming back to this address;
//   · anything else (a dropped connection, a failed query, a bug) → rethrown as it is, so it
//     reaches the segment's error boundary, which offers a retry, and `onRequestError`
//     (instrumentation.ts) logs it.
// Each call site used to wrap `resolveProjectId` in a bare `catch { notFound() }`, which answered
// all three with "Project not found". The classifier copies `classifyOrgScopeFailure`
// (`lib/auth/org-scope-failure.ts`), which does the same job for the `[org]` segment.

import { headers } from "next/headers";
import { redirect, unstable_rethrow } from "next/navigation";
import { resolveProjectId } from "@/app/server/actions/resolve";
import { UnauthorizedError } from "@/lib/auth/errors";
import { signInHref } from "@/lib/auth/sign-in-href";
import { ORG_PATH_HEADER } from "@/lib/authz/org-path";

/** What a failed project resolution is answered with, when it has an answer of its own. */
export type ProjectResolveFailure = "sign-in" | "not-found";

/** The digest Next's `notFound()` puts on what it throws. */
const NOT_FOUND_DIGEST = "NEXT_HTTP_ERROR_FALLBACK;404";

/** Whether `e` is what Next's `notFound()` throws. Read off the digest, as Next itself does. */
function isNotFoundThrow(e: unknown): boolean {
	return typeof e === "object" && e !== null && "digest" in e && e.digest === NOT_FOUND_DIGEST;
}

/**
 * Classifies what `resolveProjectId` threw. Returns only for the two failures that have a page of
 * their own, and RETHROWS everything else.
 *
 * - `UnauthorizedError`: there is no session → `"sign-in"`.
 * - The `notFound()` `resolveProjectId` throws for a slug that resolves to no project in the
 *   viewer's scope → `"not-found"`.
 * - Next's other control flow (a redirect, a dynamic-rendering bailout) is rethrown untouched by
 *   `unstable_rethrow`.
 * - Anything else is rethrown as the same value. It is not a statement about the project, so it
 *   must not be reported as one.
 *
 * By class and by digest, never by message.
 */
export function classifyProjectResolveFailure(e: unknown): ProjectResolveFailure {
	if (e instanceof UnauthorizedError) return "sign-in";
	if (isNotFoundThrow(e)) return "not-found";
	unstable_rethrow(e);
	throw e;
}

/**
 * The id of the project the URL's `slug` names, or `null` when it names none this viewer can see.
 *
 * `null` is the 404, and the CALLER throws it: `(await resolveProjectOr404(slug)) ?? notFound()`.
 * The `notFound()` stays in the page's own source for two reasons. `scripts/check-route-states.mjs`
 * finds a route's `notFound()` by reading that route's file, and holds it to a `not-found.tsx`
 * scoped to the same resource. And the `[project]` layout must NOT throw it: a throw from the
 * layout escapes `[project]/not-found.tsx` and lands on the org's (#3880), so the layout renders
 * its children bare on `null` and lets the page below answer.
 *
 * A lost session redirects to sign-in from here, with the address this request was for as the
 * destination (the path `proxy.ts` publishes; a server component is not given it). `redirect()`
 * throws, so that branch never returns. Every other failure is rethrown by the classifier.
 */
export async function resolveProjectOr404(slug: string): Promise<string | null> {
	try {
		return await resolveProjectId(slug);
	} catch (e) {
		if (classifyProjectResolveFailure(e) === "sign-in") {
			redirect(signInHref((await headers()).get(ORG_PATH_HEADER)));
		}
		return null;
	}
}
