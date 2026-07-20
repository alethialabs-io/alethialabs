// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Project preview-environment config — the per-project settings that drive the ephemeral
// PR-preview ApplicationSet (spec management/spec/features/environments-fabric-placement.md,
// W-f / D10). One row per project (a project has a single preview generator watching one repo).
// The runner renders an ArgoCD ApplicationSet with a Pull Request generator from this config
// (packages/core/argocd/applicationset_preview.go): create-on-open, deploy head_sha,
// destroy-on-close. `placement_mode` picks the per-team tenancy of each preview
// (namespace|vcluster); `dedicated` is not a valid preview placement (validated in
// lib/validations/preview.ts). This activates the inert lifecycle/placement seam #836 left on
// project_environments.

import {
	boolean,
	index,
	pgTable,
	text,
	timestamp,
	unique,
	uuid,
} from "drizzle-orm/pg-core";
import { gitProvider, placementMode } from "./enums";
import { projectGitCredentials } from "./project-components";
import { projectFabrics } from "./project-fabrics";
import { projects } from "./projects";

export const projectPreviewConfig = pgTable(
	"project_preview_config",
	{
		id: uuid().primaryKey().defaultRandom(),
		project_id: uuid()
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		// Coarse tenancy scope (RLS blast wall); community org_id = user_id.
		user_id: uuid().notNull(),
		org_id: uuid(),
		// Master switch — when false the runner renders no preview ApplicationSet.
		enabled: boolean().default(false).notNull(),
		// The repo whose open pull requests generate previews (the ArgoCD PR generator source).
		git_provider: gitProvider().notNull(),
		repo_owner: text().notNull(),
		repo_name: text().notNull(),
		// Path within the repo holding the deployable manifests (ArgoCD Application source path).
		apps_path: text().default(".").notNull(),
		// Per-team tenancy of each preview env: namespace (default) | vcluster.
		placement_mode: placementMode().default("namespace").notNull(),
		// Which Fabric (infra unit) hosts the previews. NULL → the project's default Fabric.
		fabric_id: uuid().references(() => projectFabrics.id, {
			onDelete: "set null",
		}),
		// Namespace prefix for namespace-placed previews (e.g. "preview" → preview-pr-42).
		namespace_prefix: text().default("preview").notNull(),
		// Credential that seeds the ArgoCD token secret the PR generator polls GitHub/GitLab with.
		// NULL → the generator has no token (only public repos / anonymous listing work).
		git_credential_id: uuid().references(() => projectGitCredentials.id, {
			onDelete: "set null",
		}),
		created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
		updated_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [
		unique("project_preview_config_project_id_key").on(t.project_id),
		index("idx_project_preview_config_project").on(t.project_id),
	],
);

export type ProjectPreviewConfig = typeof projectPreviewConfig.$inferSelect;
export type NewProjectPreviewConfig = typeof projectPreviewConfig.$inferInsert;
