// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";
import type { CloudProviderSlug } from "@/lib/cloud-providers";
import type { ProjectFormData } from "@/lib/validations/project-form.schema";

/** One inferred backing-service need, each justified by evidence in the repo. */
export const inferredNeedSchema = z.object({
	kind: z.enum(["database", "cache", "queue", "topic", "nosql", "secret"]),
	engine: z
		.string()
		.optional()
		.describe("Generic engine family, e.g. postgresql, mysql, redis."),
	sizeHint: z.enum(["small", "medium", "large"]).optional(),
	name: z.string().optional().describe("Suggested resource name (slugged)."),
	confidence: z.number().min(0).max(1),
	rationale: z.string().describe("The signal that justifies this need."),
});

/** The model's structured read of a repository's infrastructure needs. */
export const inferredStackSchema = z.object({
	runtime: z.string().describe("Primary language/runtime, e.g. node, python, go."),
	framework: z.string().optional().describe("e.g. express, django, next.js, rails."),
	summary: z.string().describe("One sentence: what the app is + what it needs."),
	scale: z.enum(["small", "medium", "large"]).default("small"),
	container: z.object({
		dockerfile: z.boolean(),
		port: z.number().int().optional(),
	}),
	needs: z.array(inferredNeedSchema),
});

export type InferredNeed = z.infer<typeof inferredNeedSchema>;
export type InferredStack = z.infer<typeof inferredStackSchema>;

/** A scan's review-ready proposal: the inferred stack + a guaranteed-valid project. */
export interface ScanProposal {
	stack: InferredStack;
	proposedProject: ProjectFormData;
	provider: CloudProviderSlug;
	identityId: string;
}
