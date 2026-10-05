// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: LicenseRef-Alethia-Commercial

// The server-side half of the reserved-slug rule (#5445) and of the org-slug shape (#5509).
//
// An organization's slug is the FIRST path segment of every URL inside it, so a slug that a console
// route (`/login`, `/api`), the marketing zone (`/pricing`) or a sibling app (`/docs`) already owns
// produces an organization nobody can reach — or worse, one that shadows the route. The console
// refused such a slug only in its forms (the create-a-team sheet, onboarding), and better-auth's
// `/organization/create` and `/organization/update` are plain HTTP endpoints: a request that skipped
// the form was accepted. These two hooks run inside those endpoints, so the refusal holds whoever
// the caller is.
//
// The same endpoints also accepted any SHAPE: `-acme`, `acme--cloud`, a 64-character slug — each
// refused by every console form and stored anyway by a direct call. So the hooks also apply the
// org-slug rule (@repo/org-slug: lowercase words joined by single hyphens, at most 63 characters).
//
// Both rules are core's (`reservedOrgSlugRefusal`, lib/routing.ts; `orgSlugShapeRefusal`, read by
// core from @repo/org-slug), INJECTED rather than imported: ee/ takes only erased type imports from
// core at runtime (see index.ts). The reserved check runs first, so `Docs` is still answered as
// reserved rather than as a capital letter.
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
 * slug, or one that breaks the org-slug shape, with a 400 `APIError` carrying core's code and
 * sentence.
 *
 * An update that does not touch the slug passes untouched: better-auth sends only the fields being
 * changed, and a name-only edit has no slug to judge.
 *
 * @param refuseReserved core's reserved-slug rule (`CoreContext.reservedOrgSlugRefusal`)
 * @param refuseShape core's org-slug shape rule (`CoreContext.orgSlugShapeRefusal`)
 */
export function orgSlugHooks(
  refuseReserved: CoreContext["reservedOrgSlugRefusal"],
  refuseShape: CoreContext["orgSlugShapeRefusal"],
): {
  beforeCreateOrganization: (data: SlugPayload) => Promise<void>;
  beforeUpdateOrganization: (data: SlugPayload) => Promise<void>;
} {
  /** Throws the refusal for a reserved or mis-shaped slug; returns for any other (or absent) slug. */
  const guard = (slug: string | undefined): void => {
    if (typeof slug !== "string") return;
    const refusal = refuseReserved(slug) ?? refuseShape(slug);
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
