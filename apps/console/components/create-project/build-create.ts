// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// What the create screen sends, and where it goes after: the `CreateProjectInput` for the chosen
// starting point, and the canvas seed (`lib/projects/canvas-handoff.ts`) the canvas starts from.
//
// Pure: the screen hands in the parsed form values and the scan, and gets both back.

import type { CreateProjectInput } from "@/app/server/actions/projects";
import { DEFAULT_ENVIRONMENT_MATRIX } from "@/components/design-project/placement-selector";
import type { FieldErrors } from "@/lib/actions/result";
import type { CanvasSeed } from "@/lib/projects/canvas-handoff";
import type { EnvironmentSpec } from "@/lib/queries/projects";
import { projectSchema } from "@/lib/validations/project-form.schema";

import type { CreateProjectOutput } from "./create-project.wizard";
import { buildCreateInput, buildEmptyCreateInput } from "./templates";

/**
 * A new project's environments: production alone, on its own cluster. More are added from the
 * project; the first screen asks nothing about environments or placement.
 */
export const PRODUCTION_ONLY: EnvironmentSpec[] = DEFAULT_ENVIRONMENT_MATRIX.filter((env) => env.is_default);

/** What the create sends, and the seed the canvas opens with. */
export interface CreatePlan {
	readonly input: CreateProjectInput;
	readonly seed: CanvasSeed;
}

/** The project's first environment, in the region the person chose. */
function firstEnvironment(region: string) {
	return { name: "production", stage: "production" as const, region };
}

/** An empty project: no cluster preset and no cloud account, both chosen on the canvas. */
function emptyInput(values: CreateProjectOutput): CreateProjectInput {
	return buildEmptyCreateInput({
		projectName: values.name,
		defaultEnvironment: firstEnvironment(values.region),
		environments: PRODUCTION_ONLY,
	});
}

/**
 * The create for `values`. `scan.design` is a ready scan's proposed project.
 *
 *   - import: the scan's proposal with the name, region and account from the screen; the seed names
 *     the scan, the design the server keeps for it. Without a ready proposal (a scan that did not
 *     finish, created without it) the project is empty and the canvas starts blank.
 *   - a template: the cluster preset on the chosen cloud when an account was chosen, an empty project
 *     when not; the template seed sizes the cluster on the canvas either way, and a missing account
 *     is the canvas review's to report.
 *   - blank: an empty project; the canvas starts blank.
 *   - your chart or module: an empty project; the canvas opens the attach flow.
 */
export function buildCreate(
	values: CreateProjectOutput,
	scan: { readonly jobId: string | null; readonly design: CreateProjectInput | null },
): CreatePlan {
	switch (values.source) {
		case "import": {
			if (scan.design === null || scan.jobId === null) {
				return { input: emptyInput(values), seed: { kind: "blank" } };
			}
			const base = scan.design;
			return {
				input: {
					...base,
					project: {
						...base.project,
						project_name: values.name,
						region: values.region,
						cloud_identity_id: values.identityId,
						environments: PRODUCTION_ONLY,
					},
				},
				seed: { kind: "proposal", proposalId: scan.jobId },
			};
		}
		case "standard":
		case "ai":
		case "custom": {
			const seed: CanvasSeed = { kind: "template", templateId: values.source, provider: values.provider };
			if (!values.identityId) return { input: emptyInput(values), seed };
			return {
				input: buildCreateInput({
					projectName: values.name,
					template: values.source,
					provider: values.provider,
					cloudIdentityId: values.identityId,
					defaultEnvironment: firstEnvironment(values.region),
					environments: PRODUCTION_ONLY,
				}),
				seed,
			};
		}
		case "blank":
			return { input: emptyInput(values), seed: { kind: "blank" } };
		case "byo-helm":
			return { input: emptyInput(values), seed: { kind: "byo", attach: "chart" } };
		case "byo-iac":
			return { input: emptyInput(values), seed: { kind: "byo", attach: "iac" } };
	}
}

/** The form key a refusal no field owns is filed under; the wizard shows it above the button. */
export const FORM_REFUSAL_KEY = "form";

/**
 * Which field a create refusal is about. The server returns the refusal as a sentence with no field,
 * so this asks the two questions the screen can answer for itself rather than reading the sentence:
 * does the name break the project schema's rule, and does the org already hold it (asked of the
 * server again, `isNameTaken`)? Either one puts it on the name. Otherwise it is about the cloud
 * account when one was sent — the only other thing on the screen the server checks — and about the
 * name when none was. A check that fails to answer is not read as "the name is free".
 */
export async function refusalFields(args: {
	readonly message: string;
	readonly name: string;
	readonly identitySent: boolean;
	readonly isNameTaken: () => Promise<boolean | null>;
}): Promise<FieldErrors> {
	const { message, name, identitySent, isNameTaken } = args;
	if (!projectSchema.shape.project_name.safeParse(name.trim()).success) return { name: [message] };
	const taken = await isNameTaken();
	if (taken === true || !identitySent) return { name: [message] };
	if (taken === false) return { identityId: [message] };
	return { [FORM_REFUSAL_KEY]: [message] };
}
