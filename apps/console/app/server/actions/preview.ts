"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Ephemeral PR-preview environments (W-f, #842) — the console-side RESOLVER for a Fabric's preview
// configuration. A preview env is an ArgoCD ApplicationSet pullRequest generator installed on the
// Fabric: ArgoCD discovers each OPEN pull request on the apps repo and renders one preview
// Application per PR (create-on-open, deploy head_sha, destroy-on-close). The generator's inputs —
// the apps repo, its SCM coordinates, the per-team placement — are all DERIVED here from the data
// model (project_repositories + project_environments + project_fabrics); the user only chooses a
// placement + TTL. This layer reads and validates; it never touches the cloud.
//
// The runner half that installs the ApplicationSet + seeds the SCM token Secret on the Fabric
// (packages/core/argocd RenderPreviewApplicationSet / EnsurePreviewSCMSecret + the deploy dispatch)
// lands separately — so this ships behind ALETHIA_PREVIEW_ENVS_ENABLED (off by default), exactly
// like the BYO-IaC console half shipped ahead of its runner.

import { and, eq } from "drizzle-orm";
import { authorize } from "@/lib/authz/guard";
import { withActorScope } from "@/lib/db";
import { projectEnvironments, projectFabrics, projectRepositories } from "@/lib/db/schema";
import { resolveActiveEnvironmentId } from "@/app/server/actions/resolve";
import { isPreviewEnvsEnabled } from "@/lib/addons/preview-envs-flag";
import {
	DEFAULT_PREVIEW_TTL_HOURS,
	parseAppsRepoScm,
	PREVIEW_SCM_SECRET_KEY,
	PREVIEW_SCM_SECRET_NAME,
	type PreviewConfigInput,
	type PreviewPlacement,
	type PreviewScmProvider,
	previewConfigInputSchema,
} from "@/lib/validations/preview";

/**
 * The fully-resolved preview configuration for a Fabric — everything the ArgoCD pullRequest
 * generator (RenderPreviewApplicationSet) needs, secret-free. The SCM token itself never appears
 * here; it is seeded into `tokenSecretName` out-of-band and referenced by the generator's tokenRef.
 */
export interface ResolvedPreviewConfig {
	/** The Fabric the preview ApplicationSet installs onto (previews share the Fabric's infra). */
	fabricId: string;
	fabricName: string;
	/** The GitOps apps repo whose OPEN PRs get a preview env (also the ArgoCD sync source). */
	appsRepo: string;
	scmProvider: PreviewScmProvider;
	scmOwner: string;
	scmRepo: string;
	/** Per-team placement of each preview env on the Fabric. */
	placement: PreviewPlacement;
	/** Prefixes each PR's destination namespace ("<prefix>-<pr-number>"). */
	namespacePrefix: string;
	/** Preview lifetime cap (hours) for a follow-up reaper; ArgoCD tears down on PR close. */
	ttlHours: number;
	tokenSecretName: string;
	tokenSecretKey: string;
}

/** getPreviewConfig outcome: the resolved config, or an honest reason previews aren't available. */
export type PreviewConfigResult =
	| { available: true; config: ResolvedPreviewConfig }
	| { available: false; reason: string };

/**
 * Resolves the preview configuration for a project environment's Fabric: the apps repo (from
 * project_repositories), the SCM coordinates derived from it, and the placement (from the env's
 * placement_mode). An optional `override` lets the UI preview the effect of a user's placement/TTL
 * choice before enabling. Returns `available:false` with a reason (fail-closed) when the feature is
 * off, the env has no Fabric, there's no apps repo, or the apps repo host isn't a supported SCM.
 */
export async function getPreviewConfig(
	projectId: string,
	environmentId?: string | null,
	override?: PreviewConfigInput,
): Promise<PreviewConfigResult> {
	if (!isPreviewEnvsEnabled()) {
		return {
			available: false,
			reason: "Preview environments are not enabled on this instance.",
		};
	}

	const actor = await authorize("view", { type: "project", id: projectId });
	const envId = await resolveActiveEnvironmentId(projectId, environmentId);
	// A user's placement/TTL choice is validated before it overlays the derived defaults.
	const choice = override ? previewConfigInputSchema.parse(override) : undefined;

	return withActorScope(actor, async (tx) => {
		const [env] = await tx
			.select({
				fabric_id: projectEnvironments.fabric_id,
				placement_mode: projectEnvironments.placement_mode,
				name: projectEnvironments.name,
			})
			.from(projectEnvironments)
			.where(
				and(
					eq(projectEnvironments.id, envId),
					eq(projectEnvironments.project_id, projectId),
				),
			)
			.limit(1);
		if (!env) return { available: false, reason: "Environment not found." };
		if (!env.fabric_id) {
			return { available: false, reason: "This environment is not linked to a Fabric yet." };
		}

		const [repos] = await tx
			.select({ apps_destination_repo: projectRepositories.apps_destination_repo })
			.from(projectRepositories)
			.where(
				and(
					eq(projectRepositories.project_id, projectId),
					eq(projectRepositories.environment_id, envId),
				),
			)
			.limit(1);
		const appsRepo = repos?.apps_destination_repo?.trim();
		if (!appsRepo) {
			return {
				available: false,
				reason: "Connect a GitOps apps repository to enable preview environments.",
			};
		}

		const scm = parseAppsRepoScm(appsRepo);
		if (!scm) {
			return {
				available: false,
				reason:
					"The apps repository host is not supported for PR previews (github or gitlab required).",
			};
		}

		const [fabric] = await tx
			.select({ name: projectFabrics.name })
			.from(projectFabrics)
			.where(
				and(
					eq(projectFabrics.id, env.fabric_id),
					eq(projectFabrics.project_id, projectId),
				),
			)
			.limit(1);

		// Placement: honour the user's choice if given, else the env's placement (a `dedicated` host
		// env still hosts namespace-per-PR previews, so it falls back to namespace).
		const placement: PreviewPlacement =
			choice?.placement ??
			(env.placement_mode === "namespace" || env.placement_mode === "vcluster"
				? env.placement_mode
				: "namespace");

		return {
			available: true,
			config: {
				fabricId: env.fabric_id,
				fabricName: fabric?.name ?? env.name,
				appsRepo,
				scmProvider: scm.provider,
				scmOwner: scm.owner,
				scmRepo: scm.repo,
				placement,
				namespacePrefix: "preview",
				ttlHours: choice?.ttlHours ?? DEFAULT_PREVIEW_TTL_HOURS,
				tokenSecretName: PREVIEW_SCM_SECRET_NAME,
				tokenSecretKey: PREVIEW_SCM_SECRET_KEY,
			},
		};
	});
}
