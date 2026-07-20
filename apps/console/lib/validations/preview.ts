// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Validation for the ephemeral PR-preview config (W-f). Derived from the project_preview_config
// table with drizzle-zod, refined to the user-facing subset. `dedicated` is intentionally rejected
// as a preview placement — a preview is a lightweight namespace|vcluster tenant, never a whole
// dedicated Fabric (spec environments-fabric-placement.md, D3).

import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { projectPreviewConfig } from "@/lib/db/schema";

/** Placement modes valid for an ephemeral preview (dedicated is excluded). */
export const PREVIEW_PLACEMENT_MODES = ["namespace", "vcluster"] as const;
export type PreviewPlacementMode = (typeof PREVIEW_PLACEMENT_MODES)[number];

/** A GitHub/GitLab owner or repo segment: no whitespace, slashes, or path traversal. */
const repoSegment = z
	.string()
	.trim()
	.min(1)
	.max(100)
	.regex(/^[A-Za-z0-9._-]+$/, "must be a single owner/repo segment");

/** Input schema for configurePreviewEnvironments — the settings a user edits. */
export const previewConfigSchema = createInsertSchema(projectPreviewConfig, {
	git_provider: z.enum(["github", "gitlab", "bitbucket"]),
	repo_owner: repoSegment,
	repo_name: repoSegment,
	apps_path: z
		.string()
		.trim()
		.transform((p) => p.replace(/^\/+|\/+$/g, ""))
		.transform((p) => (p === "" ? "." : p))
		// Restrict to a repo-relative path charset — this value is interpolated into the rendered
		// ApplicationSet YAML, so reject anything that could break out of the field.
		.refine(
			(p) => /^[A-Za-z0-9._/-]+$/.test(p),
			"must be a repo-relative path (letters, digits, . _ - /)",
		)
		.optional(),
	placement_mode: z.enum(PREVIEW_PLACEMENT_MODES).optional(),
	namespace_prefix: z
		.string()
		.trim()
		.min(1)
		.max(40)
		.regex(/^[a-z0-9-]+$/, "must be a DNS-1123 label prefix")
		.optional(),
	fabric_id: z.string().uuid().nullish(),
	git_credential_id: z.string().uuid().nullish(),
	enabled: z.boolean().optional(),
}).pick({
	enabled: true,
	git_provider: true,
	repo_owner: true,
	repo_name: true,
	apps_path: true,
	placement_mode: true,
	fabric_id: true,
	namespace_prefix: true,
	git_credential_id: true,
});

export type PreviewConfigInput = z.input<typeof previewConfigSchema>;
export type PreviewConfigParsed = z.output<typeof previewConfigSchema>;
