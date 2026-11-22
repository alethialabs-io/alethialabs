// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Bring-your-own IaC, declared for the wizard engine (`lib/wizard/`). The dialog that shows it is
// `byo-iac-dialog.tsx`; the overlay is `?wizard=byo-iac&step=<id>`.
//
// Every rule is the attach form's own (`iacSourceFormSchema`), picked per step, so Next refuses what
// Attach would. `tests/lib/wizard/definitions.test.ts` holds this definition to completeness and to
// keeping no credential-shaped draft key.

import { z } from "zod";
import { byoWizardId } from "@/lib/projects/canvas-handoff";
import { iacSourceFormSchema } from "@/lib/validations/byo-iac";
import { defineWizard } from "@/lib/wizard/define";

/** The wizard's URL and draft namespace (`?wizard=byo-iac`): the id a `byo` canvas seed opens. */
export const BYO_IAC_WIZARD_ID = byoWizardId("iac");

/** The wizard's values, as typed. */
export type ByoIacWizardValues = z.input<typeof iacSourceFormSchema>;

/** The wizard's values once the attach form's rules have parsed them. */
export type ByoIacWizardOutput = z.output<typeof iacSourceFormSchema>;

/**
 * The attach-an-IaC-source wizard. The draft keeps the repository, path and ref, and NOT the
 * variables: a tfvar value is free text, and the module's variables are retyped faster than a
 * stored one could be trusted to hold no credential. The Variables step says so after a restore.
 */
export const byoIacWizard = defineWizard<ByoIacWizardValues, ByoIacWizardOutput>({
	id: BYO_IAC_WIZARD_ID,
	presentation: "overlay",
	schema: iacSourceFormSchema,
	steps: [
		{
			id: "repository",
			label: "Repository",
			fields: ["repo_url"],
			schema: iacSourceFormSchema.pick({ repo_url: true }),
			// Linking a git provider leaves the console and returns to this URL.
			gate: { kind: "external", returnParams: [] },
		},
		{
			id: "path-ref",
			label: "Path & ref",
			fields: ["path", "ref"],
			schema: iacSourceFormSchema.pick({ path: true, ref: true }),
		},
		{
			id: "variables",
			label: "Variables",
			fields: ["variables"],
			schema: iacSourceFormSchema.pick({ variables: true }),
		},
		{ id: "review", label: "Review", fields: [], schema: z.object({}) },
	],
	draft: {
		version: 1,
		ttlMinutes: 24 * 60,
		schema: z.object({
			repo_url: z.string().optional(),
			path: z.string().optional(),
			ref: z.string().optional(),
		}),
	},
});
