// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Bring-your-own Helm chart, declared for the wizard engine (`lib/wizard/`). The dialog that shows
// it is `byo-chart-dialog.tsx`; the overlay is `?wizard=byo-chart&step=<id>`.
//
// The git remote and the OCI reference are two fields, not one `repoUrl`: each is shown by its own
// step, and the engine requires every field to have exactly one step that shows it. They become the
// action's one `repoUrl` only when the chart is attached (`toChartForm`).
//
// Every rule is the attach form's own (`byoChartFormSchema`), run per step, so Next refuses what
// Attach would. `tests/lib/wizard/definitions.test.ts` holds this definition to completeness and to
// keeping no credential-shaped draft key.

import { z } from "zod";
import { byoWizardId } from "@/lib/projects/canvas-handoff";
import {
	byoChartFormSchema,
	CHART_SOURCES,
	type ByoChartFormValues,
	type ChartSource,
} from "@/lib/validations/byo-charts";
import { defineWizard } from "@/lib/wizard/define";

/** The wizard's URL and draft namespace (`?wizard=byo-chart`): the id a `byo` canvas seed opens. */
export const BYO_CHART_WIZARD_ID = byoWizardId("chart");

/** Every field the wizard holds, as typed. */
const chartFieldsSchema = z.object({
	source: z.enum(CHART_SOURCES),
	gitUrl: z.string(),
	ociRef: z.string(),
	chartPath: z.string(),
	ref: z.string(),
	name: z.string(),
	namespace: z.string(),
	valuesYaml: z.string(),
});

/** The wizard's values. */
export type ByoChartWizardValues = z.infer<typeof chartFieldsSchema>;

/** A wizard field. */
type ChartField = keyof ByoChartWizardValues;

/** The wizard's values in the attach form's shape: one `repoUrl`, from the source's own field. */
function toChartForm(values: ByoChartWizardValues): ByoChartFormValues {
	return {
		source: values.source,
		repoUrl: values.source === "oci" ? values.ociRef : values.gitUrl,
		chartPath: values.chartPath,
		ref: values.ref,
		name: values.name,
		namespace: values.namespace,
		valuesYaml: values.valuesYaml,
	};
}

/** The wizard field an attach-form (or attach-action) key is shown in, for this source. */
export function wizardFieldOf(key: string, source: ChartSource): string {
	if (key === "repoUrl") return source === "oci" ? "ociRef" : "gitUrl";
	// The action's `id` is derived from the name the Review step shows.
	if (key === "id") return "name";
	return key;
}

/**
 * The attach form's rules, reported on the wizard's fields. `owned` keeps only the issues on those
 * fields, which is what one step checks; `null` keeps every issue, which is what Attach checks.
 */
function chartRules(owned: readonly ChartField[] | null) {
	return chartFieldsSchema.superRefine((values, ctx) => {
		const parsed = byoChartFormSchema.safeParse(toChartForm(values));
		if (parsed.success) return;
		for (const issue of parsed.error.issues) {
			const [head, ...rest] = issue.path;
			const field = wizardFieldOf(String(head ?? ""), values.source);
			if (owned !== null && !owned.some((name) => name === field)) continue;
			ctx.addIssue({ code: "custom", path: [field, ...rest], message: issue.message });
		}
	});
}

/** Whether the chart comes from a git repository. */
const fromGit = (values: ByoChartWizardValues) => values.source !== "oci";

/** Whether the chart comes from an OCI registry. */
const fromOci = (values: ByoChartWizardValues) => values.source === "oci";

/**
 * The attach-a-chart wizard. The draft keeps everything but the Helm values: values files are where
 * people put passwords, and nothing about a values block needs to survive a reload more than it needs
 * to stay out of storage. The Review step says so.
 */
export const byoChartWizard = defineWizard<ByoChartWizardValues, ByoChartWizardValues>({
	id: BYO_CHART_WIZARD_ID,
	presentation: "overlay",
	schema: chartRules(null),
	steps: [
		{ id: "source", label: "Source", fields: ["source"], schema: chartRules(["source"]) },
		{
			id: "repository",
			label: "Repository",
			fields: ["gitUrl"],
			schema: chartRules(["gitUrl"]),
			when: fromGit,
			// Linking a git provider leaves the console and returns to this URL.
			gate: { kind: "external", returnParams: [] },
		},
		{
			id: "registry",
			label: "Registry",
			fields: ["ociRef"],
			schema: chartRules(["ociRef"]),
			when: fromOci,
		},
		{
			id: "chart-path",
			label: "Chart path",
			fields: ["chartPath"],
			schema: chartRules(["chartPath"]),
			when: fromGit,
		},
		{ id: "ref", label: "Ref", fields: ["ref"], schema: chartRules(["ref"]) },
		{
			id: "review",
			label: "Review",
			fields: ["name", "namespace", "valuesYaml"],
			schema: chartRules(["name", "namespace", "valuesYaml"]),
		},
	],
	draft: {
		version: 1,
		ttlMinutes: 24 * 60,
		schema: z.object({
			source: z.enum(CHART_SOURCES).optional(),
			gitUrl: z.string().optional(),
			ociRef: z.string().optional(),
			chartPath: z.string().optional(),
			ref: z.string().optional(),
			name: z.string().optional(),
			namespace: z.string().optional(),
		}),
	},
});
