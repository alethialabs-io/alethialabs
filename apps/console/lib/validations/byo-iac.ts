// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Input validation for the bring-your-own IaC (E3) server actions — derived from the
// project_iac_sources drizzle schema per the drizzle-zod convention, with the JSONB /
// user-facing columns refined (repo URL shape, normalized path, scalar-only tfvars).

import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { projectIacSources } from "@/lib/db/schema";
import type { IacVarValues } from "@/types/jsonb.types";

/** Basic sanity on a git repo URL — an https:// or git@ remote. Deep validation happens when the
 * runner clones it; this just rejects obvious garbage at save time. */
export function isPlausibleRepoUrl(url: string): boolean {
	return /^https:\/\/\S+$/.test(url) || /^git@\S+:\S+$/.test(url);
}

/** The attachIacSource input — the insertable user-facing columns of project_iac_sources.
 * Server-derived columns (commit_sha, scan_*, status, timestamps) are omitted: the scan
 * pipeline owns them. */
export const iacSourceAttachSchema = createInsertSchema(projectIacSources, {
	repo_url: z
		.string()
		.trim()
		.refine(isPlausibleRepoUrl, "Enter a valid git repository URL (https:// or git@…)."),
	ref: z.string().trim().min(1).nullish(),
	path: z
		.string()
		.trim()
		// Normalize "/foo/" → "foo" so the runner joins it safely under the clone dir.
		.transform((p) => p.replace(/^\/+|\/+$/g, ""))
		.optional(),
	git_credential_id: z.string().uuid().nullish(),
	// Scalar-only tfvars (IacVarValues) — no nested objects/arrays, no secrets.
	var_values: z
		.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
		.optional()
		.transform((v): IacVarValues => v ?? {}),
}).pick({
	repo_url: true,
	ref: true,
	path: true,
	git_credential_id: true,
	var_values: true,
});

export type IacSourceAttachInput = z.input<typeof iacSourceAttachSchema>;
