// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: LicenseRef-Alethia-Commercial

// The server-side half of the reserved-slug rule (#5445).
//
// An organization's slug is the FIRST path segment of every URL inside it, so a slug that a console
// route (`/login`, `/api`), the marketing zone (`/pricing`) or a sibling app (`/docs`) already owns
// produces an organization nobody can reach — or worse, one that shadows the route. The console
// refused such a slug only in its forms (the create-a-team sheet, onboarding), and better-auth's
// `/organization/create` and `/organization/update` are plain HTTP endpoints: a request that skipped
// the form was accepted. These two hooks run inside those endpoints, so the refusal holds whoever
// the caller is.
//
// The rule itself is core's (`reservedOrgSlugRefusal`, lib/routing.ts), INJECTED rather than
// imported: ee/ takes only erased type imports from core at runtime (see index.ts).
//
// An `APIError` is the right vehicle. better-auth answers it as a 400 with the body below, which its
// client hands back as `{ error: { code, message } }` — a value, never a redacted throw — and the
// `code` lets a form tell "reserved" from "taken" without reading the sentence.

import { APIError } from "better-auth/api";
import type { CoreContext } from "@/lib/enterprise";

/** The slug-bearing part of the payload both hooks receive (create: the new org; update: the patch). */
interface SlugPayload {
  organization: { slug?: string };
}

/**
 * Builds the `beforeCreateOrganization` / `beforeUpdateOrganization` pair that refuses a reserved
 * slug with a 400 `APIError` carrying core's code and sentence.
 *
 * An update that does not touch the slug passes untouched: better-auth sends only the fields being
 * changed, and a name-only edit has no slug to judge.
 *
 * @param refuse core's reserved-slug rule (`CoreContext.reservedOrgSlugRefusal`)
 */
export function orgSlugHooks(refuse: CoreContext["reservedOrgSlugRefusal"]): {
  beforeCreateOrganization: (data: SlugPayload) => Promise<void>;
  beforeUpdateOrganization: (data: SlugPayload) => Promise<void>;
} {
  /** Throws the refusal for a reserved slug; returns for any other (or absent) slug. */
  const guard = (slug: string | undefined): void => {
    if (typeof slug !== "string") return;
    const refusal = refuse(slug);
    if (refusal) {
      throw new APIError("BAD_REQUEST", {
        code: refusal.code,
        message: refusal.message,
      });
    }
  };
  return {
    beforeCreateOrganization: async ({ organization }) => guard(organization.slug),
    beforeUpdateOrganization: async ({ organization }) => guard(organization.slug),
  };
}
