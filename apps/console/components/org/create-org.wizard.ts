// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Create a team, declared for the wizard engine (`lib/wizard/`) as an overlay of four steps
// (WIZ-W7, #6930): `?wizard=create-org&step=name|declare|pay|invite`.
//
// What the engine gives the sheet:
//   - the open state and the step in the URL, so Back, a link and a reload reproduce them;
//   - a tab draft of the team's NAME and SLUG, and nothing else, so a reload on the declaration
//     step comes back filled in;
//   - the irreversible gate on `pay`: before any step is shown, `settle()` asks where a paid setup
//     stands — this tab's record first, then the server (`recoverUnfinishedPaidSetup`) — and the
//     URL can never move the sheet past `pay` on its own. Only the sheet's machine reaching
//     `invite`, after a finished setup, re-settles the gate as done.
//
// What it does NOT take from the engine, on purpose: deciding which panel of `pay` is shown, and
// the moves into `pay` and `invite`. Those are the machine's (`create-org-machine.ts`): a URL that
// names a step the machine has not reached is put back where the machine is.
//
// What the draft never keeps: the payer declaration (an attestation restored filled in is one
// nobody gave now), the billing details, the card, the Stripe client secret, the invitee emails —
// none of them is a form field here, and the draft lists only `name` and `slug`.
// `tests/lib/wizard/definitions.test.ts` holds this file to the engine's rules.

import { ORG_SLUG_PATTERN } from "@repo/org-slug";
import { z } from "zod";
import { ORG_SLUG_MAX, tooLongMessage } from "@/lib/billing/billing-field-caps";
import { ORG_SLUG_RESERVED_MESSAGE, RESERVED_SLUGS } from "@/lib/routing";
import { finishSlugDraft } from "@/lib/utils/slugify";
import { defineWizard } from "@/lib/wizard/define";
import { SETTLE_FAILED_MESSAGE } from "@/lib/wizard/steps";
import type { Settlement, WizardDefinition, WizardStep } from "@/lib/wizard/types";

/** The overlay's URL and draft namespace (`?wizard=create-org`). */
export const CREATE_ORG_WIZARD_ID = "create-org";

/** What a team's draft belongs to: the account, not an org — a team is created from any of them. */
export const CREATE_ORG_DRAFT_SCOPE = "account";

/** The form's values as typed. The slug is a draft that may end in a hyphen until it is finished. */
export interface CreateOrgValues {
	name: string;
	slug: string;
}

/** The submit contract: the team's name and the slug its draft will be submitted as. */
const createOrgSchema = z.object({
	name: z.string().trim().min(2, "Give your team a name."),
	slug: z
		.string()
		.trim()
		// The field holds a DRAFT while it is typed into (`slugifyDraft`, #5453): `acme-` is the state
		// it is in between `acme` and `acme-cloud`. The checks below judge the slug that draft will be
		// submitted as, so a half-typed hyphen is not refused mid-word. The sheet writes the same
		// finished value back into the form before anything reads it with `getValues`.
		.transform(finishSlugDraft)
		.pipe(
			z
				.string()
				.min(1, "Pick a slug.")
				// The server's cap for the slug it records with a paid setup (billing-field-caps.ts).
				.max(ORG_SLUG_MAX, tooLongMessage(ORG_SLUG_MAX))
				.regex(ORG_SLUG_PATTERN, "Lowercase letters, numbers and hyphens.")
				// Checked HERE, not left to `isOrgSlugAvailable`: that action answers one boolean for both
				// "reserved" and "taken", so a reserved slug ("docs") used to be refused as TAKEN (#5442).
				// RESERVED_SLUGS is the same set the action and `configureOnboardingOrg` consult.
				.refine((s) => !RESERVED_SLUGS.has(s), ORG_SLUG_RESERVED_MESSAGE),
		),
});

/** The values once the submit schema has parsed them. */
export type CreateOrgOutput = z.output<typeof createOrgSchema>;

/** The steps that own no field: their progress is the machine's, not the form's. */
const NO_FIELDS = z.object({});

/** The first step: the only one with fields. Exported so the sheet validates it the engine's way. */
export const CREATE_ORG_NAME_STEP: WizardStep<CreateOrgValues> = {
	id: "name",
	label: "Team",
	fields: ["name", "slug"],
	schema: createOrgSchema,
};

/**
 * The create-team wizard with `settle` as the payment step's gate. The sheet passes one that reads
 * its own state and this tab's record before asking the server; see the header.
 */
export function defineCreateOrgWizard(
	settle: () => Promise<Settlement>,
): WizardDefinition<CreateOrgValues, CreateOrgOutput> {
	return defineWizard<CreateOrgValues, CreateOrgOutput>({
		id: CREATE_ORG_WIZARD_ID,
		presentation: "overlay",
		schema: createOrgSchema,
		steps: [
			CREATE_ORG_NAME_STEP,
			{ id: "declare", label: "Who is paying", fields: [], schema: NO_FIELDS },
			{
				id: "pay",
				label: "Payment",
				fields: [],
				schema: NO_FIELDS,
				gate: { kind: "irreversible", settle },
			},
			{ id: "invite", label: "Invite", fields: [], schema: NO_FIELDS },
		],
		draft: {
			version: 1,
			ttlMinutes: 24 * 60,
			schema: z.object({
				name: z.string().optional(),
				slug: z.string().optional(),
			}),
		},
	});
}

/**
 * The definition with a gate that cannot answer, for the definitions test and any reader that has
 * no sheet around it. Its `settle()` says the check failed — never "not started" — so nothing built
 * on it alone could offer a payment.
 */
export const createOrgWizard = defineCreateOrgWizard(() =>
	Promise.resolve({ kind: "unknown", message: SETTLE_FAILED_MESSAGE }),
);
