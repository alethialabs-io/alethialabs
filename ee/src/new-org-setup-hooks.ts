// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: LicenseRef-Alethia-Commercial

// The organization-create half of a paid create-a-team setup (#5445).
//
// The create-a-team sheet charges first and creates the organization after, sending the charge's
// subscription id in the new organization's metadata so the server can find that organization again
// if the create response is lost. These two hooks make that marker a server fact rather than a
// browser claim:
//
//   - `beforeCreateOrganization` asks core whether the creating user owns the setup record the marker
//     names. If so the marker is kept and the creator is stamped beside it IN THE SAME INSERT; if not,
//     both keys are removed. A setup that already has its organization refuses the create — one
//     organization per charge, held by the server whoever the caller is.
//   - `afterCreateOrganization` writes the new organization's id onto that record.
//   - `beforeUpdateOrganization` makes an update that writes the metadata carry the STORED marker, so
//     the keys can neither be forged onto an existing organization nor dropped by a settings save.
//
// The rules are core's (lib/billing/pending-org-setup.ts), INJECTED: ee/ takes only erased type
// imports from core at runtime (see index.ts).

import { APIError } from "better-auth/api";
import type { CoreContext } from "@/lib/enterprise";

/** The part of the create payload these hooks read and rewrite. */
interface CreatePayload {
  organization: { metadata?: unknown };
  user: { id: string };
}

/** The part of the update payload the update hook reads and rewrites. */
interface UpdatePayload {
  organization: { metadata?: unknown };
  member: { organizationId: string };
}

/** The part of the created organization the after-hook reads. */
interface CreatedPayload {
  organization: { id: string; metadata?: unknown };
  user: { id: string };
}

/**
 * Builds the before/after create hooks for the paid create-a-team marker.
 *
 * @param setup core's `newOrgSetup` capabilities
 */
export function newOrgSetupHooks(setup: CoreContext["newOrgSetup"]): {
  beforeCreateOrganization: (
    data: CreatePayload,
  ) => Promise<{ data: { metadata: Record<string, unknown> | undefined } } | undefined>;
  afterCreateOrganization: (data: CreatedPayload) => Promise<void>;
  beforeUpdateOrganization: (
    data: UpdatePayload,
  ) => Promise<{ data: { metadata: Record<string, unknown> } } | undefined>;
} {
  return {
    beforeCreateOrganization: async ({ organization, user }) => {
      const verdict = await setup.stampMetadata(organization.metadata, user.id);
      // Metadata carrying neither key is left exactly as sent.
      if (verdict === null) return undefined;
      if ("refusal" in verdict) {
        throw new APIError("BAD_REQUEST", {
          code: verdict.refusal.code,
          message: verdict.refusal.message,
        });
      }
      return { data: { metadata: verdict.metadata } };
    },
    afterCreateOrganization: async ({ organization, user }) => {
      await setup.recordCreated(organization.id, organization.metadata, user.id);
    },
    beforeUpdateOrganization: async ({ organization, member }) => {
      const kept = await setup.keepStoredMarker(member.organizationId, organization.metadata);
      return kept ? { data: kept } : undefined;
    },
  };
}
