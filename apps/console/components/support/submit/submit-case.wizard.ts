// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The new-case wizard, declared once for the wizard engine (`lib/wizard/`).
//
// Five steps — type, area, severity, details, contact — each owning the fields it renders, so a
// failure found on submit (or a server's field refusal) sends the person to the step that shows the
// field. `tests/lib/wizard/definitions.test.ts` holds this file to that: every key of the submit
// schema below has exactly one owner.
//
// What is NOT here, on purpose:
//   - `context` (the console URL and the browser) is stamped by the form when it submits; nobody
//     types it, so no step owns it.
//   - `abuse` details belong to the dedicated abuse form; this wizard links to it instead of
//     offering "abuse" as a type (G-14).
//
// The draft keeps every typed value except the attachments: a `File` cannot be stored, so the
// details step tells the person to re-attach after a reload.

import { z } from "zod";
import {
	supportCaseCategory,
	supportCaseSeverity,
	supportCaseType,
} from "@/lib/db/schema/enums";
import { submitCaseSchema } from "@/lib/validations/support";
import { defineWizard } from "@/lib/wizard/define";

/** The case types this wizard offers: every type but abuse, which has its own form. */
export const wizardCaseTypeSchema = z.enum(supportCaseType.enumValues).exclude(["abuse"]);

/** One case type this wizard offers. */
export type WizardCaseType = z.infer<typeof wizardCaseTypeSchema>;

/** The case types this wizard offers, in the order the type step shows them. */
export const WIZARD_CASE_TYPES = wizardCaseTypeSchema.options;

/** The wizard's submit contract: the shared case contract without the fields no step owns. */
export const submitCaseWizardSchema = submitCaseSchema.omit({ context: true, abuse: true });

/** The form's values as typed. */
export type SubmitCaseWizardValues = z.input<typeof submitCaseWizardSchema>;

/** The values once the submit contract has parsed them. */
export type SubmitCaseWizardOutput = z.output<typeof submitCaseWizardSchema>;

/** The id of each step, in order. */
export type SubmitCaseStepId = "type" | "area" | "severity" | "details" | "contact";

export const submitCaseWizard = defineWizard<SubmitCaseWizardValues, SubmitCaseWizardOutput>({
	id: "support-case",
	presentation: "page",
	schema: submitCaseWizardSchema,
	steps: [
		{
			id: "type",
			label: "Type",
			fields: ["type"],
			schema: z.object({ type: wizardCaseTypeSchema }),
		},
		{
			id: "area",
			label: "Area",
			fields: ["category"],
			schema: submitCaseWizardSchema.pick({ category: true }),
		},
		{
			id: "severity",
			label: "Severity",
			fields: ["severity"],
			schema: submitCaseWizardSchema.pick({ severity: true }),
		},
		{
			id: "details",
			label: "Details",
			fields: ["subject", "description"],
			schema: submitCaseWizardSchema.pick({ subject: true, description: true }),
		},
		{
			id: "contact",
			label: "Contact",
			fields: ["contact.notifyEmail", "contact.channel"],
			schema: submitCaseWizardSchema.pick({ contact: true }),
		},
	],
	draft: {
		version: 1,
		ttlMinutes: 24 * 60,
		schema: z.object({
			type: wizardCaseTypeSchema.optional(),
			category: z.enum(supportCaseCategory.enumValues).optional(),
			severity: z.enum(supportCaseSeverity.enumValues).optional(),
			subject: z.string().optional(),
			description: z.string().optional(),
			contact: z
				.object({
					notifyEmail: z.string(),
					channel: z.enum(["email", "in_app"]),
				})
				.optional(),
		}),
	},
});
