// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// THE organization-slug rule: what an org's URL segment may be. One copy, read by every place that
// accepts an org slug — `configureOnboardingOrg`, the operator `provisionOrg`, the create-a-team
// form, the server's record of a paid setup (`pendingOrgSetupSlugSchema`) and the marketing-zone
// reservation that decides which marketing paths could collide with one.
//
// It replaced five hand-copied regexes (#5509). Four agreed; the paid-setup record's read
// `^[a-z0-9]*(?:-[a-z0-9]+)*$` — a `*` where the others had `+` — so it accepted `-acme` (and the
// empty string) that every other check refused. The form never produced one, but the server must
// refuse on its own.
//
// Availability is NOT part of this rule: reserved console routes (lib/routing.ts RESERVED_SLUGS)
// and global uniqueness are each caller's to check. Keep this file dependency-free apart from the
// slug length — client components import it.

import { SLUG_MAX_LENGTH } from "@/lib/utils/slugify";

/**
 * An org slug's shape: lowercase letters and digits in words joined by SINGLE hyphens. So no leading
 * or trailing hyphen (`-acme`, `acme-`), no double hyphen (`acme--cloud`), and never empty.
 */
export const ORG_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The longest org slug — THE slug limit (`SLUG_MAX_LENGTH`, the DNS-1123 label length). */
export const ORG_SLUG_MAX_LENGTH = SLUG_MAX_LENGTH;

/** Whether `slug` (already trimmed and lower-cased by the caller) satisfies the org-slug rule. */
export function isOrgSlug(slug: string): boolean {
	return slug.length <= ORG_SLUG_MAX_LENGTH && ORG_SLUG_PATTERN.test(slug);
}
