// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The abuse report, declared for the wizard engine (`lib/wizard/`) as ONE step. It is a single page,
// so it takes none of the engine's URL handling (the form passes a location that does nothing); what
// it takes is the rest:
//   - a tab draft, so a reload, Back or a detour does not throw the report away (G-07);
//   - a server field refusal on the field it names, and one that names no field shown above the
//     button instead of nowhere (G-04).
//
// What is NOT here, on purpose: `type`, `category` and `severity` are fixed for every abuse report,
// and `context` (the console URL and the browser) is stamped when it is filed — nobody types them,
// so no field owns them; the form adds them at submit (`abuseReportSubmission`).
// `tests/lib/wizard/definitions.test.ts` holds this file to the engine's rules: every key of the
// submit schema has exactly one owner, and the draft is an allowlist.

import type { FieldPath } from "react-hook-form";
import { z } from "zod";
import { supportAbuseCategory } from "@/lib/db/schema/enums";
import { contactPrefsSchema, submitCaseSchema } from "@/lib/validations/support";
import { defineWizard } from "@/lib/wizard/define";

/** What the person fills in: the shared case contract's typed fields, with only the email of `contact`. */
export const abuseReportSchema = submitCaseSchema
	.pick({ subject: true, description: true, abuse: true })
	.extend({ contact: contactPrefsSchema.pick({ notifyEmail: true }) });

/** The form's values as typed. */
export type AbuseReportValues = z.input<typeof abuseReportSchema>;

/** The values once the report's schema has parsed them. */
export type AbuseReportOutput = z.output<typeof abuseReportSchema>;

/** The fields the one step renders, in the order they appear. */
export const ABUSE_REPORT_FIELDS: readonly FieldPath<AbuseReportValues>[] = [
	"abuse.abuseCategory",
	"abuse.reportedResource",
	"abuse.reporterRelationship",
	"subject",
	"description",
	"contact.notifyEmail",
];

/** The abuse report as a one-step wizard: its submit contract, its one step and its tab draft. */
export const abuseReportWizard = defineWizard<AbuseReportValues, AbuseReportOutput>({
	id: "support-abuse",
	presentation: "page",
	schema: abuseReportSchema,
	steps: [
		{
			id: "report",
			label: "Report",
			fields: ABUSE_REPORT_FIELDS,
			schema: abuseReportSchema,
		},
	],
	draft: {
		version: 1,
		ttlMinutes: 24 * 60,
		schema: z.object({
			subject: z.string().optional(),
			description: z.string().optional(),
			abuse: z
				.object({
					reportedResource: z.string().optional(),
					abuseCategory: z.enum(supportAbuseCategory.enumValues).optional(),
					reporterRelationship: z.enum(["third_party", "affected_party"]).optional(),
				})
				.optional(),
			contact: z.object({ notifyEmail: z.string() }).optional(),
		}),
	},
});

/**
 * The case an abuse report files: what the person typed, plus the fields every abuse report has
 * (type, category, severity, the email channel) and the console context of the moment it is filed.
 */
export function abuseReportSubmission(
	values: AbuseReportOutput,
	context: { consoleUrl: string; userAgent: string },
): z.input<typeof submitCaseSchema> {
	const submission: z.input<typeof submitCaseSchema> = {
		type: "abuse",
		category: "other",
		severity: "high",
		subject: values.subject,
		description: values.description,
		abuse: values.abuse,
		contact: { notifyEmail: values.contact.notifyEmail, channel: "email" },
		context,
	};
	return submission;
}
