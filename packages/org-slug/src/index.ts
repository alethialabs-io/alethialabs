// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// THE organization-slug rule: what an org's URL segment may look like — its characters and its
// length. It lives in a package because two apps check it (#5509): a copy kept in apps/console
// could not be imported by apps/admin, so the staff app held its own regex and a 64-character cap
// while the console capped at 63.
//
// Read by, in apps/console: `configureOnboardingOrg`, `provisionOrg` and the provision-org route
// in front of it, the create-a-team form, the server's record of a paid setup
// (`pendingOrgSetupSlugSchema`), the billing field caps, the marketing-zone reservation that decides
// which marketing paths could collide with a slug, and — injected through `CoreContext`, because
// ee/ takes no runtime import from core — ee's `beforeCreateOrganization` /
// `beforeUpdateOrganization` hooks, so a better-auth call that skips every form is held to it too.
// In apps/admin: the Enterprise create flow's `createSchema` (app/orgs/actions.ts).
//
// What enforces "one copy": tests/one-copy.test.ts fails when this pattern's exact source text
// appears in a .ts/.tsx file under apps/console or apps/admin (app/, components/, lib/) or under any
// packages/*/src other than this file. It reads the exact text only, so a copy spelled differently
// is not seen.
//
// Availability is NOT part of this rule: reserved console routes (apps/console lib/routing.ts
// RESERVED_SLUGS) and global uniqueness are each caller's to check. Keep this file dependency-free —
// client components import it.

/**
 * An org slug's characters: lowercase letters and digits in words joined by SINGLE hyphens. So no
 * leading or trailing hyphen (`-acme`, `acme-`), no double hyphen (`acme--cloud`), and never empty.
 */
export const ORG_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The longest org slug: 63, the DNS-1123 label length (the console's `SLUG_MAX_LENGTH`). */
export const ORG_SLUG_MAX_LENGTH = 63;

/** The refusal code for a slug longer than {@link ORG_SLUG_MAX_LENGTH}. */
export const ORG_SLUG_TOO_LONG_CODE = "ORG_SLUG_TOO_LONG";

/** The sentence for a slug longer than {@link ORG_SLUG_MAX_LENGTH}. */
export const ORG_SLUG_TOO_LONG_MESSAGE = `Use at most ${ORG_SLUG_MAX_LENGTH} characters.`;

/** The refusal code for a slug whose characters break {@link ORG_SLUG_PATTERN} (or that is empty). */
export const ORG_SLUG_INVALID_FORMAT_CODE = "ORG_SLUG_INVALID_FORMAT";

/** Why a slug breaks the rule: a code a caller can branch on and a sentence a person can act on. */
export interface OrgSlugShapeRefusal {
	code: typeof ORG_SLUG_TOO_LONG_CODE | typeof ORG_SLUG_INVALID_FORMAT_CODE;
	message: string;
}

/**
 * Why `slug` (already trimmed and lower-cased by the caller) breaks the org-slug rule, or null when
 * it satisfies it. Length is judged first: a 64-character slug told "use lowercase letters" has
 * nothing to fix.
 */
export function orgSlugShapeRefusal(slug: string): OrgSlugShapeRefusal | null {
	if (slug.length > ORG_SLUG_MAX_LENGTH) {
		return { code: ORG_SLUG_TOO_LONG_CODE, message: ORG_SLUG_TOO_LONG_MESSAGE };
	}
	if (!ORG_SLUG_PATTERN.test(slug)) {
		return {
			code: ORG_SLUG_INVALID_FORMAT_CODE,
			message: "Use lowercase letters, numbers and hyphens.",
		};
	}
	return null;
}

/** Whether `slug` (already trimmed and lower-cased by the caller) satisfies the org-slug rule. */
export function isOrgSlug(slug: string): boolean {
	return orgSlugShapeRefusal(slug) === null;
}
