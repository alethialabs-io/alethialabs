"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Deploy tab's server read (#574): GitOps wiring facts + per-component ArgoCD
// health for one environment. Thin authz/tenancy shell over the shared read model in
// lib/gitops/deploy-status.ts (the same assembly the canvas badges ride through
// getEnvironmentComponentStatus, so the two surfaces can never disagree).

import { and, eq } from "drizzle-orm";
import { authorize } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";
import { projectEnvironments, projects } from "@/lib/db/schema";
import {
	EMPTY_GITOPS_DEPLOY_STATUS,
	readGitopsDeployStatus,
	type GitopsDeployStatus,
} from "@/lib/gitops/deploy-status";
import { resolveActiveEnvironmentId } from "@/app/server/actions/resolve";

/**
 * GitOps deploy status for one environment (default env when none given).
 *
 * PDP-gated (`view`). The component/job tables are RLS-less project children, so — exactly
 * as in getEnvironmentComponentStatus — the org boundary is enforced HERE by joining the
 * environment to its parent project and filtering on the caller's org; a foreign project
 * UUID returns the empty model.
 */
export async function getGitopsDeployStatus(
	projectId: string,
	environmentId?: string | null,
): Promise<GitopsDeployStatus> {
	const actor = await authorize("view", { type: "project", id: projectId });
	const db = getServiceDb();

	const resolvedEnvId = await resolveActiveEnvironmentId(
		projectId,
		environmentId ?? undefined,
	).catch(() => null);
	if (!resolvedEnvId) return EMPTY_GITOPS_DEPLOY_STATUS;

	// The tenancy wall: this environment must belong to a project in the caller's org.
	const [env] = await db
		.select({ id: projectEnvironments.id })
		.from(projectEnvironments)
		.innerJoin(projects, eq(projectEnvironments.project_id, projects.id))
		.where(
			and(
				eq(projectEnvironments.id, resolvedEnvId),
				eq(projectEnvironments.project_id, projectId),
				eq(projects.org_id, actor.orgId),
			),
		)
		.limit(1);
	if (!env) return EMPTY_GITOPS_DEPLOY_STATUS;

	return readGitopsDeployStatus(projectId, env.id);
}
