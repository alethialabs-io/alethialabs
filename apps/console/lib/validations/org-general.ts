// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The organization General-settings form (#6128): ONE schema, read by the form (react-hook-form's
// resolver) and by the server action that saves it (`saveOrgGeneral`, `defineAction`'s input). The
// form refusing a value the server accepts, or the reverse, is the asymmetry this file exists to
// prevent — the project rename carried a 50-vs-100 disagreement once already.
//
// Isomorphic on purpose: no `server-only`, no database. The slug's rules are the org-slug rule's
// own (`@repo/org-slug`) and the reserved set the organization hooks consult (`lib/routing.ts`), so
// the sentence a user reads is the same whichever of them refuses.

import { ORG_SLUG_MAX_LENGTH, ORG_SLUG_PATTERN } from "@repo/org-slug";
import { z } from "zod";
import { RESERVED_SLUGS, ORG_SLUG_RESERVED_MESSAGE } from "@/lib/routing";
import { finishSlugDraft } from "@/lib/utils/slugify";

/**
 * The longest organization name, in characters. A name is shown in the switcher, the breadcrumb,
 * invitations and the danger zone's sentence; F014 saved a 300-character one and the danger zone
 * scrolled the page sideways.
 */
export const ORG_NAME_MAX_LENGTH = 64;

/** The longest organization description, in characters ("a short line for teammates"). */
export const ORG_DESCRIPTION_MAX_LENGTH = 280;

/** The longest Terraform version string (`1.9.5`, `1.10.0-rc1`). */
export const TERRAFORM_VERSION_MAX_LENGTH = 32;

/** The longest region / default-environment value (both are picked from fixed lists). */
const CHOICE_MAX_LENGTH = 64;

/** A Terraform release: `MAJOR.MINOR.PATCH`, optionally with a pre-release suffix. */
const TERRAFORM_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;

/** The sentence for a field longer than its cap. */
function tooLong(max: number): string {
	return `Use at most ${max} characters.`;
}

/**
 * The General-settings values the form edits and the server saves. The logo is not here: it is
 * saved by its own upload control (`/api/org/logo`), the moment a file is picked.
 */
export const orgGeneralSchema = z.object({
	name: z
		.string()
		.trim()
		.min(1, "An organization name is required.")
		.max(ORG_NAME_MAX_LENGTH, tooLong(ORG_NAME_MAX_LENGTH)),
	slug: z
		.string()
		.trim()
		// The field holds a DRAFT while typed (`slugifyDraft`, #5453): `acme-` is the state between
		// `acme` and `acme-cloud`. What is judged — and saved — is the finished slug.
		.transform(finishSlugDraft)
		.pipe(
			z
				.string()
				.min(1, "Pick a slug.")
				.max(ORG_SLUG_MAX_LENGTH, tooLong(ORG_SLUG_MAX_LENGTH))
				.regex(ORG_SLUG_PATTERN, "Lowercase letters, numbers and hyphens.")
				// Reserved is answered here, before a request: "taken" about a route would send the user
				// looking for an organization that does not exist (#5442). The organization hooks refuse
				// it again on the server whatever the client sent.
				.refine((s) => !RESERVED_SLUGS.has(s), ORG_SLUG_RESERVED_MESSAGE),
		),
	description: z
		.string()
		.trim()
		.max(ORG_DESCRIPTION_MAX_LENGTH, tooLong(ORG_DESCRIPTION_MAX_LENGTH)),
	region: z.string().trim().min(1, "Pick a data region.").max(CHOICE_MAX_LENGTH),
	defaultEnv: z.string().trim().min(1, "Pick a default environment.").max(CHOICE_MAX_LENGTH),
	terraformVersion: z
		.string()
		.trim()
		.max(TERRAFORM_VERSION_MAX_LENGTH, tooLong(TERRAFORM_VERSION_MAX_LENGTH))
		.regex(TERRAFORM_VERSION_PATTERN, "Use a release number such as 1.9.5."),
});

/** What the form holds (before the slug draft is finished). */
export type OrgGeneralInput = z.input<typeof orgGeneralSchema>;

/** What the server saves (the slug finished, every string trimmed). */
export type OrgGeneralValues = z.output<typeof orgGeneralSchema>;
