// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The create-project screen as a one-step page wizard (`lib/wizard/`).
//
// ONE STEP ON PURPOSE. Everything the screen asks fits on one screen, and most of it is filled in
// before the person arrives (see `deduce.ts`). The engine is still worth it for one step: one form,
// one schema, a draft that survives a reload or a git-link round trip, server refusals placed on
// their field, and nothing submitted silently.
//
// WHAT THE DRAFT KEEPS: the starting point, the name, the cloud and region, and the repository the
// person picked. Never the cloud account (re-picked from the accounts on the chosen cloud) and
// never anything secret — the screen holds no secret. The scan itself is in the URL (`?scan=`), the
// step's external return param.

import { z } from "zod";
import { CLOUD_PROVIDER_SLUGS } from "@/lib/cloud-providers/provider-slug";
import { projectSchema } from "@/lib/validations/project-form.schema";
import { defineWizard } from "@/lib/wizard/define";

/** Every starting point, in the order the screen lists them. */
export const CREATE_SOURCES = [
	"import",
	"standard",
	"ai",
	"blank",
	"custom",
	"byo-helm",
	"byo-iac",
] as const;

/** One starting point. */
export type CreateSource = (typeof CREATE_SOURCES)[number];

/** The starting points that are a template, by template id. */
export const TEMPLATE_SOURCES = ["standard", "ai", "custom"] as const;

/** Narrows a string to a starting point. */
export function isCreateSource(value: string): value is CreateSource {
	return CREATE_SOURCES.some((source) => source === value);
}

/** Whether a starting point creates a cluster on a cloud, so the cloud and region are asked. */
export function sourceNeedsCloud(source: CreateSource): boolean {
	return source === "import" || source === "standard" || source === "ai" || source === "custom";
}

/** The query param a scan travels in; it is the step's external return param. */
export const SCAN_PARAM = "scan";

/** What "Connect a cloud account" says when an import has none. */
export const IMPORT_NEEDS_ACCOUNT =
	"Connect a cloud account. The scan's design is placed on one.";

/** The submit contract. The name rule is the project schema's own. */
export const createProjectSchema = z
	.object({
		source: z.enum(CREATE_SOURCES),
		name: projectSchema.shape.project_name,
		provider: z.enum(CLOUD_PROVIDER_SLUGS),
		identityId: z.string(),
		region: z.string(),
		repoUrl: z.string(),
		ref: z.string(),
	})
	.superRefine((values, ctx) => {
		if (sourceNeedsCloud(values.source) && values.region === "") {
			ctx.addIssue({ code: "custom", path: ["region"], message: "Pick a region." });
		}
		if (values.source === "import" && values.identityId === "") {
			ctx.addIssue({ code: "custom", path: ["identityId"], message: IMPORT_NEEDS_ACCOUNT });
		}
	});

/** The form's values. */
export type CreateProjectValues = z.input<typeof createProjectSchema>;

/** The values once the submit contract has parsed them. */
export type CreateProjectOutput = z.output<typeof createProjectSchema>;

/** The wizard's id: the URL and draft namespace. */
export const CREATE_PROJECT_WIZARD_ID = "create-project";

export const createProjectWizard = defineWizard<CreateProjectValues, CreateProjectOutput>({
	id: CREATE_PROJECT_WIZARD_ID,
	presentation: "page",
	schema: createProjectSchema,
	steps: [
		{
			id: "project",
			label: "Project",
			fields: ["source", "name", "provider", "identityId", "region", "repoUrl", "ref"],
			schema: createProjectSchema,
			gate: { kind: "external", returnParams: [SCAN_PARAM] },
		},
	],
	draft: {
		version: 1,
		ttlMinutes: 24 * 60,
		schema: z.object({
			source: z.enum(CREATE_SOURCES).optional(),
			name: z.string().optional(),
			provider: z.enum(CLOUD_PROVIDER_SLUGS).optional(),
			region: z.string().optional(),
			repoUrl: z.string().optional(),
			ref: z.string().optional(),
		}),
	},
});
