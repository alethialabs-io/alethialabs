// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A wizard definition that exists for the tests. It is named `*.wizard.ts` on purpose: the
// definitions test finds definitions by that name, and this file is how that test proves its
// search finds anything at all before the first real wizard is declared.
//
// It has every shape the engine treats differently: a step that is skipped for some values
// (`placement`), a step holding a field that only fails on submit (`capacity`'s `surge`), a rule
// that spans steps (the region must exist on the cloud), and a field the draft does not keep
// (`note`).

import { z } from "zod";
import { defineWizard } from "@/lib/wizard/define";

/** The submit contract of the example wizard. */
export const examplePoolSchema = z
	.object({
		provider: z.string().min(1, "Pick a cloud"),
		region: z.string(),
		min: z.number().min(0, "Cannot be negative"),
		surge: z.string().regex(/^[1-9]\d*$/, "At least 1"),
		note: z.string(),
	})
	.refine((values) => values.provider !== "aws" || values.region !== "fsn1", {
		path: ["region"],
		message: "That region is not on this cloud",
	})
	.refine((values) => values.note !== "refuse", { message: "This pool cannot be created" });

/** The values of the example wizard's form. */
export type ExamplePoolValues = z.infer<typeof examplePoolSchema>;

/** The form's values before the user has typed anything. */
export const EXAMPLE_POOL_DEFAULTS: ExamplePoolValues = {
	provider: "",
	region: "",
	min: 1,
	surge: "1",
	note: "",
};

export const examplePoolWizard = defineWizard<ExamplePoolValues, ExamplePoolValues>({
	id: "example-pool",
	presentation: "page",
	schema: examplePoolSchema,
	steps: [
		{
			id: "cloud",
			label: "Cloud",
			fields: ["provider"],
			schema: z.object({ provider: z.string().min(1, "Pick a cloud") }),
		},
		{
			id: "placement",
			label: "Placement",
			fields: ["region"],
			schema: z.object({ region: z.string().min(1, "Pick a region") }),
			when: (values) => values.provider !== "local",
		},
		{
			id: "capacity",
			label: "Capacity",
			fields: ["min", "surge"],
			schema: z.object({ min: z.number().min(0, "Cannot be negative") }),
		},
		{
			id: "review",
			label: "Review",
			fields: ["note"],
			schema: z.object({ note: z.string() }),
		},
	],
	draft: {
		version: 1,
		ttlMinutes: 60,
		schema: z.object({
			provider: z.string(),
			region: z.string(),
			min: z.number(),
			surge: z.string(),
		}),
	},
});
